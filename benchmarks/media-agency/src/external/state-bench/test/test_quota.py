import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import pytest

spec = importlib.util.spec_from_file_location("agency_client_test", Path(__file__).parents[1] / "clients/agency.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_exhausted_credit_stops_new_clients_before_another_request(monkeypatch, tmp_path):
    monkeypatch.setenv("AGENCY_ROOT", str(tmp_path))
    monkeypatch.setenv("AGENCY_TRACE_DIR", str(tmp_path / "traces"))
    monkeypatch.setattr(module.AgencyClient, "quota_error", None)
    requests = []
    def execute(*args, **kwargs):
        requests.append(args)
        return SimpleNamespace(stdout=json.dumps({"error": "OpenAI HTTP 429 credit_balance_exhausted"}))
    monkeypatch.setattr(module.subprocess, "run", execute)
    with pytest.raises(RuntimeError, match="credit_balance_exhausted"):
        module.AgencyClient().generate({})
    with pytest.raises(RuntimeError, match="credit_balance_exhausted"):
        module.AgencyClient().generate({})
    assert len(requests) == 1
    assert "credit_balance_exhausted" in (tmp_path / "agency-errors.jsonl").read_text()
