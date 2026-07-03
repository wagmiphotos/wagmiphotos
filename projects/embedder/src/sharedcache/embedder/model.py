from typing import Protocol


class ClipEncoder(Protocol):
    def encode_text(self, text: str) -> list[float]: ...
    def encode_image(self, image_bytes: bytes) -> list[float]: ...


class OpenClipEncoder:
    """CLIP over open_clip. Heavy deps (torch/open_clip/PIL) are imported lazily
    so the module is importable — and the app testable — without the `model` extra."""

    def __init__(self, model_name: str = "ViT-L-14", pretrained: str = "openai", device: str = "cpu"):
        import open_clip
        import torch
        self._torch = torch
        self._model, _, self._preprocess = open_clip.create_model_and_transforms(
            model_name, pretrained=pretrained
        )
        self._model.eval().to(device)
        self._tokenizer = open_clip.get_tokenizer(model_name)
        self._device = device

    def encode_text(self, text: str) -> list[float]:
        with self._torch.no_grad():
            tokens = self._tokenizer([text]).to(self._device)
            return self._model.encode_text(tokens)[0].tolist()

    def encode_image(self, image_bytes: bytes) -> list[float]:
        from io import BytesIO
        from PIL import Image
        try:
            img = Image.open(BytesIO(image_bytes)).convert("RGB")
        except Exception as e:
            raise ValueError(f"undecodable image: {e}") from e
        with self._torch.no_grad():
            tensor = self._preprocess(img).unsqueeze(0).to(self._device)
            return self._model.encode_image(tensor)[0].tolist()
