"""Copy the canonical local web UI into the Android asset directory."""
from pathlib import Path
import shutil

root = Path(__file__).resolve().parents[1]
assets = root / "android" / "app" / "src" / "main" / "assets"
assets.mkdir(parents=True, exist_ok=True)
for name in ("index.html", "styles.css", "app.js", "live-voice.js"):
    shutil.copy2(root / "web" / name, assets / name)
print("Android web assets synchronized.")
