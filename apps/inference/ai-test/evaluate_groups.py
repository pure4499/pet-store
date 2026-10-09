from __future__ import annotations

import argparse
import html
import re
import shutil
from pathlib import Path
from urllib.parse import quote

import torch
import torch.nn.functional as F
from PIL import Image, ImageDraw, ImageOps
from torchvision.models import ResNet18_Weights, resnet18
from torchvision.models.detection import (
    SSDLite320_MobileNet_V3_Large_Weights,
    ssdlite320_mobilenet_v3_large,
)

ROOT = Path(__file__).parent
REFERENCE_DIR = ROOT / "references"
GROUP_DIR = ROOT / "groups"
OUTPUT_DIR = ROOT / "group-results"
REPORT_PATH = OUTPUT_DIR / "results.html"
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png"}
PET_CATEGORIES = {"cat", "dog"}
UNKNOWN_LABEL = "unknown"
COLORS = ["#177865", "#3569a8", "#a45a18", "#8a3fa0", "#c0394b"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Detect and identify multiple pets in group photos.")
    parser.add_argument(
        "--detection-threshold",
        type=float,
        default=0.35,
        help="Minimum dog/cat detector score (default: 0.35).",
    )
    parser.add_argument(
        "--unknown-score-threshold",
        type=float,
        default=0.75,
        help="Reject an identity below this cosine similarity (default: 0.75).",
    )
    parser.add_argument(
        "--unknown-margin-threshold",
        type=float,
        default=0.035,
        help="Reject an identity below this first-to-second margin (default: 0.035).",
    )
    return parser.parse_args()


def image_files(directory: Path) -> list[Path]:
    if not directory.exists():
        return []
    return sorted(
        path
        for path in directory.rglob("*")
        if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS
    )


def expected_pets(path: Path) -> set[str]:
    if path.parent == GROUP_DIR:
        raise ValueError(
            f"{path.name} must be inside a labeled folder such as groups/fido+one/."
        )
    return {name.strip().lower() for name in path.parent.name.split("+") if name.strip()}


def safe_name(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]+", "-", value).strip("-") or "photo"


def display_set(values: set[str]) -> str:
    return ", ".join(sorted(name.replace("_", " ").title() for name in values)) or "None"


def relative_url(path: Path) -> str:
    return quote(path.relative_to(OUTPUT_DIR).as_posix(), safe="/")


def main() -> None:
    args = parse_args()
    group_photos = image_files(GROUP_DIR)
    if not group_photos:
        raise RuntimeError(
            "No group photos found. Add images under a labeled folder such as "
            "ai-test/groups/fido+one/."
        )

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for old_path in OUTPUT_DIR.iterdir():
        if old_path.is_file():
            old_path.unlink()
        elif old_path.is_dir():
            shutil.rmtree(old_path)

    embedding_weights = ResNet18_Weights.DEFAULT
    embedding_preprocess = embedding_weights.transforms()
    embedding_model = resnet18(weights=embedding_weights)
    embedding_model.fc = torch.nn.Identity()
    embedding_model.eval()

    detector_weights = SSDLite320_MobileNet_V3_Large_Weights.DEFAULT
    detector_preprocess = detector_weights.transforms()
    detector_categories = detector_weights.meta["categories"]
    detector = ssdlite320_mobilenet_v3_large(weights=detector_weights)
    detector.eval()

    def embed(image: Image.Image) -> torch.Tensor:
        batch = embedding_preprocess(image.convert("RGB")).unsqueeze(0)
        with torch.inference_mode():
            vector = embedding_model(batch)
        return F.normalize(vector, dim=1).squeeze(0)

    reference_profiles: dict[str, torch.Tensor] = {}
    for pet_directory in sorted(REFERENCE_DIR.iterdir()):
        if not pet_directory.is_dir():
            continue
        files = image_files(pet_directory)
        if not files:
            continue
        embeddings = []
        for path in files:
            with Image.open(path) as source:
                embeddings.append(embed(ImageOps.exif_transpose(source)))
        reference_profiles[pet_directory.name.lower()] = F.normalize(
            torch.stack(embeddings).mean(dim=0), dim=0
        )
        print(f"Loaded {len(files)} references for {pet_directory.name}")

    if not reference_profiles:
        raise RuntimeError("No reference photos were found.")

    results = []
    for photo_index, path in enumerate(group_photos, start=1):
        expected = expected_pets(path)
        with Image.open(path) as source:
            image = ImageOps.exif_transpose(source).convert("RGB")

        detector_input = detector_preprocess(image)
        with torch.inference_mode():
            prediction = detector([detector_input])[0]

        detections = []
        for box, label_id, detector_score in zip(
            prediction["boxes"], prediction["labels"], prediction["scores"]
        ):
            score_value = float(detector_score)
            if score_value < args.detection_threshold:
                continue
            category = detector_categories[int(label_id)]
            if category not in PET_CATEGORIES:
                continue

            x1, y1, x2, y2 = (float(value) for value in box)
            padding_x = (x2 - x1) * 0.04
            padding_y = (y2 - y1) * 0.04
            crop_box = (
                max(0, int(x1 - padding_x)),
                max(0, int(y1 - padding_y)),
                min(image.width, int(x2 + padding_x)),
                min(image.height, int(y2 + padding_y)),
            )
            crop = image.crop(crop_box)
            query_embedding = embed(crop)
            rankings = sorted(
                (
                    (pet_name, torch.dot(query_embedding, profile).item())
                    for pet_name, profile in reference_profiles.items()
                ),
                key=lambda item: item[1],
                reverse=True,
            )
            top_pet, best_similarity = rankings[0]
            second_similarity = rankings[1][1] if len(rankings) > 1 else 0.0
            margin = best_similarity - second_similarity
            rejected = (
                best_similarity < args.unknown_score_threshold
                or margin < args.unknown_margin_threshold
            )
            identity = UNKNOWN_LABEL if rejected else top_pet
            detections.append(
                {
                    "box": crop_box,
                    "category": category,
                    "detector_score": score_value,
                    "identity": identity,
                    "top_pet": top_pet,
                    "similarity": best_similarity,
                    "margin": margin,
                    "rankings": rankings,
                    "crop": crop,
                }
            )

        predicted = {item["identity"] for item in detections}
        is_correct = predicted == expected
        annotated = image.copy()
        draw = ImageDraw.Draw(annotated)

        for detection_index, detection in enumerate(detections, start=1):
            color = COLORS[(detection_index - 1) % len(COLORS)]
            x1, y1, x2, y2 = detection["box"]
            line_width = max(3, round(min(image.size) / 180))
            draw.rectangle((x1, y1, x2, y2), outline=color, width=line_width)
            label = (
                f'{detection_index}. {detection["identity"].title()} '
                f'{detection["similarity"]:.3f}'
            )
            text_box = draw.textbbox((x1, y1), label)
            text_height = text_box[3] - text_box[1] + 10
            label_y = max(0, y1 - text_height)
            draw.rectangle((x1, label_y, x1 + text_box[2] - text_box[0] + 12, y1), fill=color)
            draw.text((x1 + 6, label_y + 4), label, fill="white")

            crop_path = OUTPUT_DIR / f"group-{photo_index:03d}-crop-{detection_index:02d}.jpg"
            detection["crop"].save(crop_path, quality=90)
            detection["crop_path"] = crop_path

        annotated_path = OUTPUT_DIR / f"group-{photo_index:03d}-{safe_name(path.stem)}.jpg"
        annotated.save(annotated_path, quality=90)
        results.append(
            {
                "source": path,
                "annotated_path": annotated_path,
                "expected": expected,
                "predicted": predicted,
                "correct": is_correct,
                "detections": detections,
            }
        )
        print(
            f"{'PASS' if is_correct else 'FAIL'} {path.name}: "
            f"expected={display_set(expected)} predicted={display_set(predicted)} "
            f"detections={len(detections)}"
        )

    write_report(results, args)
    correct = sum(int(item["correct"]) for item in results)
    print(f"\nGroup assignment accuracy: {correct}/{len(results)} ({correct / len(results):.1%})")
    print(f"Visual report: {REPORT_PATH}")


def write_report(results: list[dict], args: argparse.Namespace) -> None:
    cards = []
    for result in results:
        detection_cards = []
        for index, detection in enumerate(result["detections"], start=1):
            scores = "".join(
                f"<li>{html.escape(name.title())}: <strong>{score:.3f}</strong></li>"
                for name, score in detection["rankings"]
            )
            detection_cards.append(
                '<div class="detection">'
                f'<img src="{relative_url(detection["crop_path"])}" alt="Detected pet {index}">'
                '<div>'
                f'<h3>Detection {index}: {html.escape(detection["identity"].title())}</h3>'
                f'<p>{html.escape(detection["category"].title())} detector: {detection["detector_score"]:.3f}<br>'
                f'Identity margin: {detection["margin"]:.3f}</p><ol>{scores}</ol>'
                "</div></div>"
            )
        if not detection_cards:
            detection_cards.append('<p class="none">No dog or cat was detected above the threshold.</p>')

        status = "pass" if result["correct"] else "fail"
        cards.append(
            f'<article class="card {status}">'
            f'<img class="group-photo" src="{relative_url(result["annotated_path"])}" alt="Annotated group photo">'
            '<div class="body">'
            f'<span class="status">{status.upper()}</span>'
            f'<h2>{html.escape(result["source"].name)}</h2>'
            '<div class="sets">'
            f'<p><small>Expected assignments</small><strong>{html.escape(display_set(result["expected"]))}</strong></p>'
            f'<p><small>AI assignments</small><strong>{html.escape(display_set(result["predicted"]))}</strong></p>'
            "</div>"
            f'<div class="detections">{"".join(detection_cards)}</div>'
            "</div></article>"
        )

    correct = sum(int(item["correct"]) for item in results)
    report = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>UCBarkley group-photo AI test</title>
<style>
:root{{--ink:#123f39;--muted:#687771;--paper:#f5f2e8;--green:#177865;--red:#b83b42}}
*{{box-sizing:border-box}} body{{margin:0;background:var(--paper);color:var(--ink);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}}
header,main{{width:min(1200px,calc(100% - 36px));margin:auto}} header{{padding:42px 0 24px}} h1{{margin:0;font-size:clamp(32px,5vw,54px)}}
.note{{color:var(--muted);max-width:850px}} .metric{{display:inline-block;background:white;padding:15px 20px;border-radius:14px;font-size:24px;font-weight:800}}
.card{{background:white;border:3px solid transparent;border-radius:20px;overflow:hidden;margin:0 0 28px;box-shadow:0 8px 28px #123f3914}} .card.pass{{border-color:#7bc3ae}} .card.fail{{border-color:#df777b}}
.group-photo{{width:100%;max-height:720px;object-fit:contain;background:#dfe4e1;display:block}} .body{{padding:22px}} .status{{font-weight:900;letter-spacing:.1em}} .pass .status{{color:var(--green)}} .fail .status{{color:var(--red)}}
.sets{{display:grid;grid-template-columns:1fr 1fr;gap:12px}} .sets p{{background:#f3f6f4;border-radius:12px;padding:12px}} small,.sets strong{{display:block}} small,.detection p{{color:var(--muted)}}
.detections{{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}} .detection{{display:grid;grid-template-columns:120px 1fr;gap:12px;background:#f7f8f7;border-radius:14px;padding:10px}}
.detection img{{width:120px;height:140px;object-fit:contain;background:#e4e8e6;border-radius:9px}} .detection h3{{margin:4px 0}} .detection p{{font-size:13px;margin:4px 0}} .detection ol{{padding-left:18px;margin:7px 0;font-size:13px}} .none{{color:var(--red)}}
@media(max-width:620px){{.sets{{grid-template-columns:1fr}}.detection{{grid-template-columns:90px 1fr}}.detection img{{width:90px;height:120px}}}}
</style></head><body><header><h1>Group-photo identification</h1>
<p class="note">The detector finds each dog/cat, then ResNet-18 compares each crop with the pet references. Boxes are AI proposals; staff should be able to add missed pets, remove false detections, and correct identities.</p>
<p class="metric">{correct}/{len(results)} exact group assignments</p>
<p class="note">Detector threshold: {args.detection_threshold:.3f}. Unknown identity thresholds: score {args.unknown_score_threshold:.3f}, margin {args.unknown_margin_threshold:.3f}.</p>
</header><main>{''.join(cards)}</main></body></html>"""
    REPORT_PATH.write_text(report, encoding="utf-8")


if __name__ == "__main__":
    main()
