from unittest.mock import patch

from worker.agent import create_realtime_model


def test_cloud_model_uses_project_region_and_adc(monkeypatch):
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "cloud-project")
    monkeypatch.delenv("GOOGLE_CLOUD_LOCATION", raising=False)
    monkeypatch.setenv("GOOGLE_API_KEY", "should-not-be-used")
    with patch("worker.agent.google.realtime.RealtimeModel") as model:
        create_realtime_model()
        model.assert_called_once_with(
            model="gemini-3.8-live", vertexai=True,
            project="cloud-project", location="us-central1",
        )
    monkeypatch.setenv("GOOGLE_CLOUD_LOCATION", "eu")
    with patch("worker.agent.google.realtime.RealtimeModel") as model:
        create_realtime_model()
        assert model.call_args.kwargs["location"] == "eu"
