"""
Detector / Embedder abstractions, so main.py's HTTP contract never has to
change when the stub implementations below are swapped for real models
(fine-tuned YOLOv8 for detection, a fine-tuned ResNet/EfficientNet-Lite or
similar for embeddings — see plan §9 Phase 4/5, and §8 point 1 on why a
ready-made pet re-id model doesn't exist off the shelf).
"""

import hashlib
import io
import os
from abc import ABC, abstractmethod

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image, ImageOps
from torchvision import transforms
from torchvision.models import ResNet18_Weights, resnet18
from torchvision.transforms import InterpolationMode
from torchvision.models.detection import (
    SSDLite320_MobileNet_V3_Large_Weights,
    ssdlite320_mobilenet_v3_large,
)

EMBEDDING_DIM = 512


class Detector(ABC):
    @abstractmethod
    def detect(self, image_bytes: bytes) -> list[dict]:
        """Returns pet proposals with normalized bbox fields and an optional
        review_only flag for low-confidence, human-confirmation candidates."""


class Embedder(ABC):
    model_version: str
    output_dimension: int

    @abstractmethod
    def embed(self, crop_bytes: bytes) -> list[float]:
        """Returns an L2-normalized embedding vector of length EMBEDDING_DIM."""


class StubDetector(Detector):
    """Placeholder until Phase 4 wires in a real fine-tuned YOLOv8 model.

    Always returns one detection covering the central 80% of the frame. This
    is intentionally not "smart" — it exists so the rest of the pipeline
    (cropping, embedding, matching, quality scoring) is fully exercisable
    end-to-end before any real model work starts, per the plan's build order.
    """

    def detect(self, image_bytes: bytes) -> list[dict]:
        return [
            {
                "bbox_x": 0.1,
                "bbox_y": 0.1,
                "bbox_width": 0.8,
                "bbox_height": 0.8,
                "confidence": 0.9,
                "species_guess": "dog",
                "review_only": False,
            }
        ]


class StubEmbedder(Embedder):
    """Placeholder until Phase 5 wires in a real fine-tuned embedding backbone.

    Deterministically hashes the crop's bytes into a seed for a pseudo-random
    unit vector: identical crops always produce identical embeddings (so
    re-processing behaves sanely and matching-against-self works in manual
    testing), but it carries no real visual similarity signal between
    genuinely different photos of the same pet. Not meant to produce
    meaningful match accuracy — only to make the matching *pipeline*
    exercisable before a real model exists.
    """

    model_version = "stub-random-padded512-v1"
    output_dimension = EMBEDDING_DIM

    def embed(self, crop_bytes: bytes) -> list[float]:
        digest = hashlib.sha256(crop_bytes).digest()
        seed = int.from_bytes(digest[:8], "big")
        rng = np.random.default_rng(seed)
        vector = rng.normal(size=EMBEDDING_DIM)
        vector /= np.linalg.norm(vector)
        return vector.tolist()


class VisionDetector(Detector):
    """COCO dog/cat detector used by the local AI-assisted workflow.

    This is a useful development baseline rather than a pet-hotel-specific
    detector.  The contract stays identical when a fine-tuned model replaces
    it later.
    """

    def __init__(self) -> None:
        weights = SSDLite320_MobileNet_V3_Large_Weights.DEFAULT
        self.preprocess = weights.transforms()
        self.categories = weights.meta["categories"]
        self.model = ssdlite320_mobilenet_v3_large(weights=weights)
        self.model.eval()
        self.threshold = float(os.getenv("DETECTION_CONFIDENCE_THRESHOLD", "0.35"))
        self.review_threshold = float(os.getenv("DETECTION_REVIEW_THRESHOLD", "0.10"))

    def detect(self, image_bytes: bytes) -> list[dict]:
        with Image.open(io.BytesIO(image_bytes)) as source:
            image = ImageOps.exif_transpose(source).convert("RGB")
        tensor = self.preprocess(image)
        with torch.inference_mode():
            prediction = self.model([tensor])[0]

        detections: list[dict] = []
        for box, label_id, score in zip(
            prediction["boxes"], prediction["labels"], prediction["scores"]
        ):
            confidence = float(score)
            if confidence < self.review_threshold:
                continue
            species = self.categories[int(label_id)]
            if species not in {"dog", "cat"}:
                continue
            x1, y1, x2, y2 = (float(value) for value in box)
            padding_x = (x2 - x1) * 0.04
            padding_y = (y2 - y1) * 0.04
            left = max(0.0, x1 - padding_x)
            top = max(0.0, y1 - padding_y)
            right = min(float(image.width), x2 + padding_x)
            bottom = min(float(image.height), y2 + padding_y)
            detections.append(
                {
                    "bbox_x": left / image.width,
                    "bbox_y": top / image.height,
                    "bbox_width": max(1.0, right - left) / image.width,
                    "bbox_height": max(1.0, bottom - top) / image.height,
                    "confidence": confidence,
                    "species_guess": species,
                    "review_only": confidence < self.threshold,
                }
            )
            if len(detections) >= 8:
                break

        # Generic COCO detectors sometimes miss close-up faces, overhead pets,
        # or unusually groomed breeds. Uploads are pet-focused and always pass
        # through human review, so retain a conservative whole-frame proposal
        # rather than silently classifying the image as containing no pet.
        if not detections:
            detections.append(
                {
                    "bbox_x": 0.025,
                    "bbox_y": 0.025,
                    "bbox_width": 0.95,
                    "bbox_height": 0.95,
                    "confidence": 0.01,
                    "species_guess": "pet",
                    "review_only": True,
                }
            )
        return detections


class VisionEmbedder(Embedder):
    """ImageNet ResNet-18 baseline for visual pet similarity.

    It is intentionally treated as a suggestion model. It has not been trained
    for individual pet identity, so confidence thresholds and staff review are
    still mandatory.
    """

    model_version = "resnet18-imagenet-v1"
    output_dimension = EMBEDDING_DIM

    def __init__(self) -> None:
        weights = ResNet18_Weights.DEFAULT
        self.preprocess = weights.transforms()
        self.model = resnet18(weights=weights)
        self.model.fc = torch.nn.Identity()
        self.model.eval()

    def embed(self, crop_bytes: bytes) -> list[float]:
        with Image.open(io.BytesIO(crop_bytes)) as source:
            image = ImageOps.exif_transpose(source).convert("RGB")
        batch = self.preprocess(image).unsqueeze(0)
        with torch.inference_mode():
            vector = self.model(batch)
        return F.normalize(vector, dim=1).squeeze(0).tolist()


class DINOv2Embedder(Embedder):
    """DINOv2 ViT-S/14 features for individual-pet similarity.

    The official small backbone emits 384 values. UCBarkley's existing pgvector
    columns are 512-wide, so the normalized feature is zero-padded to 512. Zero
    padding preserves cosine similarity exactly while allowing a safe staged
    migration. Matching still filters by model_version; ResNet and DINOv2
    vectors must never be compared merely because they share a storage width.
    """

    model_version = "dinov2-vits14-reg-padded512-v1"
    output_dimension = EMBEDDING_DIM
    native_dimension = 384

    def __init__(self) -> None:
        self.preprocess = transforms.Compose(
            [
                transforms.Resize(256, interpolation=InterpolationMode.BICUBIC),
                transforms.CenterCrop(224),
                transforms.ToTensor(),
                transforms.Normalize(
                    mean=(0.485, 0.456, 0.406),
                    std=(0.229, 0.224, 0.225),
                ),
            ]
        )
        self.model = torch.hub.load(
            "facebookresearch/dinov2",
            "dinov2_vits14_reg",
            trust_repo=True,
        )
        self.model.eval()

    def embed(self, crop_bytes: bytes) -> list[float]:
        with Image.open(io.BytesIO(crop_bytes)) as source:
            image = ImageOps.exif_transpose(source).convert("RGB")
        batch = self.preprocess(image).unsqueeze(0)
        with torch.inference_mode():
            vector = F.normalize(self.model(batch), dim=1)
        if vector.shape[1] != self.native_dimension:
            raise RuntimeError(
                f"Unexpected DINOv2 embedding dimension: {vector.shape[1]}"
            )
        padded = F.pad(vector, (0, EMBEDDING_DIM - self.native_dimension))
        return padded.squeeze(0).tolist()


def create_models() -> tuple[Detector, Embedder, str]:
    backend = os.getenv("INFERENCE_MODEL_BACKEND", "vision").lower()
    if backend == "stub":
        return StubDetector(), StubEmbedder(), "stub"
    if backend != "vision":
        raise ValueError("INFERENCE_MODEL_BACKEND must be 'vision' or 'stub'")
    embedder_backend = os.getenv("INFERENCE_EMBEDDER_BACKEND", "resnet18").lower()
    if embedder_backend == "resnet18":
        embedder = VisionEmbedder()
    elif embedder_backend == "dinov2_vits14_reg":
        embedder = DINOv2Embedder()
    else:
        raise ValueError(
            "INFERENCE_EMBEDDER_BACKEND must be 'resnet18' or 'dinov2_vits14_reg'"
        )
    return VisionDetector(), embedder, f"vision+{embedder.model_version}"
