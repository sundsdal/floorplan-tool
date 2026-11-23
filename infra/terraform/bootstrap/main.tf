terraform {
  required_version = ">= 1.5"
  backend "gcs" {
    bucket = "kinhelse-shared-tfstate"
    prefix = "floorplan-ai/bootstrap"
  }
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }
}

provider "google" {
  project = "kinhelse-shared"
  region  = "europe-north1"
}

resource "google_project_service" "api" {
  for_each = toset([
    "aiplatform.googleapis.com", "apikeys.googleapis.com", "generativelanguage.googleapis.com",
    "artifactregistry.googleapis.com", "iam.googleapis.com",
    "run.googleapis.com", "secretmanager.googleapis.com", "storage.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

# Dedicated principal for the restricted Gemini Developer API auth key.
# This key must not impersonate the Vertex/recording runtime identity.
resource "google_service_account" "gemini_key" {
  account_id   = "floorplan-gemini"
  display_name = "Floorplan Gemini API key binding"
  depends_on   = [google_project_service.api]
}

resource "google_artifact_registry_repository" "images" {
  location      = "europe-north1"
  repository_id = "floorplan-ai"
  format        = "DOCKER"
  depends_on    = [google_project_service.api]
}

# Values are populated out of band and never enter Terraform state.
resource "google_secret_manager_secret" "runtime" {
  for_each = toset([
    "floorplan-gemini-key", "floorplan-livekit-key", "floorplan-livekit-secret",
    "floorplan-egress-credentials", "floorplan-session-secret",
  ])
  secret_id = each.value
  replication {
    auto {}
  }
  depends_on = [google_project_service.api]
}
