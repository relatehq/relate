import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("company_images", Path(__file__).parents[1] / "images.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ImageLockTest(unittest.TestCase):
    def test_selects_original_execution_architecture(self):
        manifests = [{"Descriptor": {"platform": {"architecture": arch, "os": "linux"},
                                       "digest": "sha256:" + digit * 64}}
                     for arch, digit in [("arm64", "1"), ("amd64", "2")]]
        self.assertEqual(module.select_digest(manifests), "sha256:" + "2" * 64)
        with self.assertRaises(ValueError):
            module.select_digest(manifests[:1])
        with self.assertRaises(ValueError):
            module.select_digest(manifests + manifests[1:])


if __name__ == "__main__":
    unittest.main()
