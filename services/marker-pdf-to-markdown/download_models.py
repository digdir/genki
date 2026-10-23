"""
Pre-download Marker models during Docker build.

This script fully initializes the Marker converter to download all required models
to the cache directory so they're available at runtime.
"""

from marker.converters.pdf import PdfConverter
from marker.models import create_model_dict
from marker.config.parser import ConfigParser

print("Downloading Marker models...")

# Configure with the same settings as the main app
config_dict = {
    "output_format": "markdown",
    "languages": "no,en",  # Norwegian and English
    "disable_image_extraction": True,
}

config_parser = ConfigParser(config_dict)

# Create the full converter to trigger all model downloads
print("Creating converter (this downloads all models)...")
converter = PdfConverter(
    config=config_parser.generate_config_dict(),
    artifact_dict=create_model_dict(),
    processor_list=config_parser.get_processors(),
    renderer=config_parser.get_renderer(),
    llm_service=config_parser.get_llm_service(),
)

print("Model download complete!")
