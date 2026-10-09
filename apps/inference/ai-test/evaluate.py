from __future__ import annotations

import argparse
import html
from pathlib import Path
from urllib.parse import quote

import torch
import torch.nn.functional as F
from PIL import Image, ImageOps
from torchvision import transforms
from torchvision.models import ResNet18_Weights, resnet18
from torchvision.transforms import InterpolationMode

ROOT = Path(__file__).parent
REFERENCE_DIR = ROOT / "references"
QUERY_DIR = ROOT / "queries"
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png"}
UNKNOWN_LABEL = "unknown"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate pet-photo similarity and create a visual report.")
    parser.add_argument(
        "--model",
        choices=("resnet18", "dinov2_vits14_reg"),
        default="resnet18",
        help="Embedding backbone to evaluate (default: resnet18).",
    )
    parser.add_argument(
        "--report-path",
        type=Path,
        help="HTML report destination (default: results-<model>.html).",
    )
    parser.add_argument(
        "--unknown-score-threshold",
        type=float,
        default=0.75,
        help="Reject the best match as unknown below this cosine similarity (default: 0.75).",
    )
    parser.add_argument(
        "--unknown-margin-threshold",
        type=float,
        default=0.035,
        help="Reject the best match when its lead over second place is below this value (default: 0.035).",
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


def image_url(path: Path) -> str:
    return quote(path.relative_to(ROOT).as_posix(), safe="/")


def display_name(value: str) -> str:
    return value.replace("_", " ").title()


def create_embedder(model_name: str):
    if model_name == "resnet18":
        weights = ResNet18_Weights.DEFAULT
        preprocess = weights.transforms()
        model = resnet18(weights=weights)
        model.fc = torch.nn.Identity()
        label = "ImageNet ResNet-18"
    else:
        preprocess = transforms.Compose(
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
        model = torch.hub.load(
            "facebookresearch/dinov2",
            "dinov2_vits14_reg",
            trust_repo=True,
        )
        label = "DINOv2 ViT-S/14 with registers"
    model.eval()
    return model, preprocess, label


def main() -> None:
    args = parse_args()
    model, preprocess, model_label = create_embedder(args.model)
    report_path = args.report_path or ROOT / f"results-{args.model}.html"

    def embed(path: Path) -> torch.Tensor:
        with Image.open(path) as source:
            image = ImageOps.exif_transpose(source).convert("RGB")
            batch = preprocess(image).unsqueeze(0)
        with torch.inference_mode():
            vector = model(batch)
        return F.normalize(vector, dim=1).squeeze(0)

    reference_profiles: dict[str, torch.Tensor] = {}
    reference_photos: dict[str, list[Path]] = {}

    for pet_directory in sorted(REFERENCE_DIR.iterdir()):
        if not pet_directory.is_dir():
            continue
        files = image_files(pet_directory)
        if not files:
            continue
        embeddings = torch.stack([embed(path) for path in files])
        reference_profiles[pet_directory.name] = F.normalize(embeddings.mean(dim=0), dim=0)
        reference_photos[pet_directory.name] = files
        print(f"Loaded {len(files)} reference photos for {pet_directory.name}")

    if not reference_profiles:
        raise RuntimeError("No reference photos were found.")

    results: list[dict] = []
    identity_correct = 0
    decision_correct = 0
    known_total = 0

    print("\nPredictions\n")

    for query_path in image_files(QUERY_DIR):
        expected_pet = query_path.parent.name.lower()
        query_embedding = embed(query_path)
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
        rejected_as_unknown = (
            best_similarity < args.unknown_score_threshold
            or margin < args.unknown_margin_threshold
        )
        predicted_pet = UNKNOWN_LABEL if rejected_as_unknown else top_pet
        is_unknown_test = expected_pet == UNKNOWN_LABEL
        top_one_correct = not is_unknown_test and top_pet == expected_pet
        is_correct = predicted_pet == expected_pet

        if not is_unknown_test:
            known_total += 1
            identity_correct += int(top_one_correct)
        decision_correct += int(is_correct)

        results.append(
            {
                "path": query_path,
                "expected": expected_pet,
                "top_pet": top_pet,
                "predicted": predicted_pet,
                "best_similarity": best_similarity,
                "margin": margin,
                "rankings": rankings,
                "correct": is_correct,
                "top_one_correct": top_one_correct,
                "rejected": rejected_as_unknown,
            }
        )

        ranking_text = ", ".join(f"{pet}: {score:.3f}" for pet, score in rankings)
        print(
            f"{'PASS' if is_correct else 'FAIL'} {query_path.name}: "
            f"expected={expected_pet}, predicted={predicted_pet}, "
            f"top_match={top_pet}, margin={margin:.3f}"
        )
        print(f"     {ranking_text}")

    total = len(results)
    top_one_accuracy = identity_correct / known_total if known_total else 0.0
    decision_accuracy = decision_correct / total if total else 0.0
    write_report(
        results=results,
        reference_photos=reference_photos,
        top_one_accuracy=top_one_accuracy,
        identity_correct=identity_correct,
        known_total=known_total,
        decision_accuracy=decision_accuracy,
        decision_correct=decision_correct,
        total=total,
        score_threshold=args.unknown_score_threshold,
        margin_threshold=args.unknown_margin_threshold,
        model_label=model_label,
        report_path=report_path,
    )

    print(f"\nKnown-pet top-1 accuracy: {identity_correct}/{known_total} ({top_one_accuracy:.1%})")
    print(f"Decision accuracy including unknown rejection: {decision_correct}/{total} ({decision_accuracy:.1%})")
    print(f"Visual report: {report_path}")


def write_report(
    *,
    results: list[dict],
    reference_photos: dict[str, list[Path]],
    top_one_accuracy: float,
    identity_correct: int,
    known_total: int,
    decision_accuracy: float,
    decision_correct: int,
    total: int,
    score_threshold: float,
    margin_threshold: float,
    model_label: str,
    report_path: Path,
) -> None:
    reference_sections = []
    for pet_name, paths in reference_photos.items():
        photos = "".join(
            f'<img src="{image_url(path)}" alt="{html.escape(pet_name)} reference">'
            for path in paths
        )
        reference_sections.append(
            f'<section class="reference-pet"><h3>{html.escape(display_name(pet_name))}</h3>'
            f'<div class="reference-strip">{photos}</div></section>'
        )

    cards = []
    for result in results:
        status_class = "pass" if result["correct"] else "fail"
        status_text = "PASS" if result["correct"] else "FAIL"
        review_badge = ""
        if result["rejected"]:
            review_badge = '<span class="badge review">Rejected as unknown</span>'
        elif result["margin"] < 0.07:
            review_badge = '<span class="badge review">Low margin — review</span>'
        else:
            review_badge = '<span class="badge confident">Clearer match</span>'

        score_rows = "".join(
            (
                '<div class="score-row">'
                f'<span>{html.escape(display_name(pet))}</span>'
                '<div class="track">'
                f'<div class="bar" style="width:{max(0, min(100, score * 100)):.1f}%"></div>'
                "</div>"
                f'<strong>{score:.3f}</strong>'
                "</div>"
            )
            for pet, score in result["rankings"]
        )

        cards.append(
            f'<article class="card {status_class}">'
            f'<div class="photo-wrap"><img src="{image_url(result["path"])}" '
            f'alt="{html.escape(result["path"].name)}"></div>'
            '<div class="card-body">'
            f'<div class="status-row"><span class="status">{status_text}</span>{review_badge}</div>'
            f'<h2>{html.escape(result["path"].name)}</h2>'
            '<div class="labels">'
            f'<div><small>Expected</small><strong>{html.escape(display_name(result["expected"]))}</strong></div>'
            f'<div><small>AI decision</small><strong>{html.escape(display_name(result["predicted"]))}</strong></div>'
            f'<div><small>Top visual match</small><strong>{html.escape(display_name(result["top_pet"]))}</strong></div>'
            "</div>"
            f'<p class="margin">First-to-second margin: <strong>{result["margin"]:.3f}</strong></p>'
            f'<div class="scores">{score_rows}</div>'
            "</div></article>"
        )

    document = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>UCBarkley AI Pet Identification Test</title>
  <style>
    :root {{ --ink:#123f39; --muted:#64746f; --paper:#f5f2e8; --green:#177865;
      --green-soft:#e4f3ed; --red:#b83b42; --red-soft:#fae8e8; --amber:#9a6500; }}
    * {{ box-sizing:border-box; }}
    body {{ margin:0; color:var(--ink); background:var(--paper); font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }}
    header, main {{ width:min(1440px, calc(100% - 40px)); margin:auto; }}
    header {{ padding:44px 0 26px; }}
    h1 {{ margin:0 0 8px; font-size:clamp(32px,5vw,56px); line-height:1; }}
    .subtitle {{ color:var(--muted); max-width:780px; }}
    .summary {{ display:flex; flex-wrap:wrap; gap:14px; margin:28px 0; }}
    .metric {{ background:white; border-radius:16px; padding:17px 20px; min-width:220px; box-shadow:0 5px 20px #123f3910; }}
    .metric strong {{ display:block; font-size:28px; }}
    .metric span, small {{ color:var(--muted); }}
    .thresholds {{ background:#fff9e8; border:1px solid #e6d39b; border-radius:14px; padding:14px 18px; color:#684a00; }}
    .references {{ background:white; border-radius:20px; padding:22px; margin:0 0 28px; }}
    .reference-pet h3 {{ margin-bottom:8px; }}
    .reference-strip {{ display:flex; gap:10px; overflow-x:auto; padding-bottom:8px; }}
    .reference-strip img {{ width:110px; height:90px; object-fit:cover; border-radius:12px; }}
    .grid {{ display:grid; grid-template-columns:repeat(auto-fill,minmax(360px,1fr)); gap:22px; padding-bottom:60px; }}
    .card {{ overflow:hidden; background:white; border-radius:20px; border:3px solid transparent; box-shadow:0 8px 28px #123f3914; }}
    .card.pass {{ border-color:#83c7b6; }} .card.fail {{ border-color:#e37e82; }}
    .photo-wrap {{ background:#dde2df; aspect-ratio:4/3; }}
    .photo-wrap img {{ width:100%; height:100%; object-fit:contain; display:block; }}
    .card-body {{ padding:18px; }} .card h2 {{ margin:10px 0 16px; font-size:18px; overflow-wrap:anywhere; }}
    .status-row {{ display:flex; align-items:center; justify-content:space-between; gap:8px; }}
    .status {{ font-weight:900; letter-spacing:.08em; }} .pass .status {{ color:var(--green); }} .fail .status {{ color:var(--red); }}
    .badge {{ border-radius:999px; padding:5px 9px; font-size:12px; font-weight:700; }}
    .badge.confident {{ background:var(--green-soft); color:var(--green); }}
    .badge.review {{ background:#fff1cb; color:var(--amber); }}
    .labels {{ display:grid; grid-template-columns:repeat(3,1fr); gap:10px; }}
    .labels div {{ background:#f4f7f5; border-radius:10px; padding:10px; }}
    .labels small, .labels strong {{ display:block; }}
    .margin {{ color:var(--muted); font-size:14px; }}
    .score-row {{ display:grid; grid-template-columns:64px 1fr 44px; align-items:center; gap:9px; margin:8px 0; font-size:13px; }}
    .track {{ height:10px; border-radius:999px; background:#e5ebe8; overflow:hidden; }}
    .bar {{ height:100%; border-radius:inherit; background:var(--green); }}
    @media (max-width:520px) {{ .grid {{ grid-template-columns:1fr; }} .labels {{ grid-template-columns:1fr; }} }}
  </style>
</head>
<body>
  <header>
    <h1>Pet identification test</h1>
    <p class="subtitle">A local {html.escape(model_label)} baseline. Similarity values are cosine scores, not probabilities. Green and red indicate whether the final decision matches the query folder label.</p>
    <div class="summary">
      <div class="metric"><span>Known-pet top-1 accuracy</span><strong>{top_one_accuracy:.1%}</strong><span>{identity_correct} of {known_total}</span></div>
      <div class="metric"><span>Decision accuracy</span><strong>{decision_accuracy:.1%}</strong><span>{decision_correct} of {total}, including unknown</span></div>
      <div class="metric"><span>Reference pets</span><strong>{len(reference_photos)}</strong><span>{sum(map(len, reference_photos.values()))} reference photos</span></div>
    </div>
    <p class="thresholds"><strong>Unknown test rule:</strong> label as unknown when the best similarity is below {score_threshold:.3f} or the first-to-second margin is below {margin_threshold:.3f}. These are experimental thresholds, not production confidence.</p>
  </header>
  <main>
    <section class="references"><h2>Reference photos</h2>{''.join(reference_sections)}</section>
    <section class="grid">{''.join(cards)}</section>
  </main>
</body>
</html>
"""
    report_path.write_text(document, encoding="utf-8")


if __name__ == "__main__":
    main()
