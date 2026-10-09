"""
Inference microservice: exposes /detect and /embed over plain HTTP. This is
the internal contract (plan §7) that insulates the rest of the system from
the CPU-vs-GPU hosting decision — the worker only ever calls this contract,
so moving this service to a serverless GPU platform later never requires
changing the worker.

Run locally: uvicorn main:app --reload --port 8000
"""

from fastapi import FastAPI, Request

from models import create_models

app = FastAPI(title="pet-hotel-inference")
detector, embedder, model_backend = create_models()


@app.get("/health")
def health():
    return {
        "status": "ok",
        "modelBackend": model_backend,
        "embeddingModel": embedder.model_version,
        "embeddingDimensions": embedder.output_dimension,
    }


@app.post("/detect")
async def detect(request: Request):
    image_bytes = await request.body()
    detections = detector.detect(image_bytes)
    return {
        "detections": [
            {
                "bboxX": d["bbox_x"],
                "bboxY": d["bbox_y"],
                "bboxWidth": d["bbox_width"],
                "bboxHeight": d["bbox_height"],
                "confidence": d["confidence"],
                "speciesGuess": d["species_guess"],
                "reviewOnly": d.get("review_only", False),
            }
            for d in detections
        ]
    }


@app.post("/embed")
async def embed(request: Request):
    crop_bytes = await request.body()
    embedding = embedder.embed(crop_bytes)
    return {
        "embedding": embedding,
        "modelVersion": embedder.model_version,
        "dimensions": embedder.output_dimension,
    }
