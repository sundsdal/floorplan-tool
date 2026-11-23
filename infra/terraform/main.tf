terraform {
  required_version = ">= 1.5"
  backend "gcs" {
    bucket = "kinhelse-shared-tfstate"
    prefix = "floorplan-ai/runtime"
  }
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }
}

locals {
  project = "kinhelse-shared"
  region  = "europe-north1"
  repo    = "${local.region}-docker.pkg.dev/${local.project}/floorplan-ai"
  live    = var.livekit != null
  lk_auth = {
    LIVEKIT_API_KEY    = "floorplan-livekit-key"
    LIVEKIT_API_SECRET = "floorplan-livekit-secret"
  }
  secrets = merge({ GEMINI_API_KEY = "floorplan-gemini-key" }, local.live ? merge(local.lk_auth, {
    LIVEKIT_SESSION_SECRET  = "floorplan-session-secret"
    LIVEKIT_GCS_CREDENTIALS = "floorplan-egress-credentials"
  }) : {})
  lk_env = local.live ? {
    LIVEKIT_URL        = var.livekit.url
    LIVEKIT_AGENT_NAME = "floorplan-guide"
  } : {}
}

provider "google" {
  project = local.project
  region  = local.region
}

variable "api_digest" {
  type = string
  validation {
    condition     = can(regex("^sha256:[a-f0-9]{64}$", var.api_digest))
    error_message = "Use the API manifest digest returned by Artifact Registry."
  }
}

variable "livekit" {
  description = "Enable the on-demand guide for a LiveKit endpoint supporting dispatch and participant Egress."
  type = object({
    url           = string
    worker_digest = string
    egress_email  = string
  })
  default = null
  validation {
    condition = var.livekit == null ? true : (
      can(regex("^wss://", var.livekit.url)) && can(regex("^sha256:[a-f0-9]{64}$", var.livekit.worker_digest))
    )
    error_message = "LiveKit needs a wss URL and an immutable worker image digest."
  }
}

variable "mobile_oauth" {
  description = "Google ID token audience and permitted account for the Floorplan AI iOS build."
  type = object({
    client_id = string
    email     = string
  })
  default = null
}

variable "inspection" {
  description = "Enable linked inspections using the approved Risikovurdering HTTPS origin and canonical floorplan Cloud Run HTTPS origin."
  type        = object({ job_origin = string, service_origin = string })
  default     = null
  validation {
    condition     = var.inspection == null ? true : alltrue([for origin in [var.inspection.job_origin, var.inspection.service_origin] : can(regex("^https://[a-zA-Z0-9.-]+$", origin))])
    error_message = "Specify HTTPS origins without a trailing slash."
  }
}

resource "google_cloud_tasks_queue" "evidence" {
  count    = var.inspection == null ? 0 : 1
  name     = "floorplan-inspection-evidence"
  location = "europe-west3"
  retry_config {
    max_attempts = 30
    min_backoff  = "2s"
    max_backoff  = "60s"
  }
  rate_limits { max_concurrent_dispatches = 2 }
}
resource "google_service_account" "tasks" {
  count      = var.inspection == null ? 0 : 1
  account_id = "floorplan-evidence-task"
}
resource "google_cloud_tasks_queue_iam_member" "enqueue" {
  count    = var.inspection == null ? 0 : 1
  name     = google_cloud_tasks_queue.evidence[0].name
  location = google_cloud_tasks_queue.evidence[0].location
  role     = "roles/cloudtasks.enqueuer"
  member   = "serviceAccount:${google_service_account.runtime.email}"
}
resource "google_service_account_iam_member" "attach_task_identity" {
  count              = var.inspection == null ? 0 : 1
  service_account_id = google_service_account.tasks[0].name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.runtime.email}"
}
resource "google_cloud_run_v2_service_iam_member" "task_invoker" {
  count    = var.inspection == null ? 0 : 1
  name     = google_cloud_run_v2_service.api.name
  location = local.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.tasks[0].email}"
}
resource "google_service_account" "runtime" {
  account_id   = "floorplan-ai"
  display_name = "Floorplan evaluation backend"
}

resource "google_project_iam_member" "vertex" {
  project = local.project
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_secret_manager_secret_iam_member" "reader" {
  for_each  = toset(values(local.secrets))
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_storage_bucket" "recordings" {
  count                       = local.live ? 1 : 0
  name                        = "${local.project}-floorplan-captures"
  location                    = local.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  lifecycle_rule {
    condition { age = 7 }
    action { type = "Delete" }
  }
}

resource "google_storage_bucket_iam_member" "drafts" {
  count  = local.live ? 1 : 0
  bucket = google_storage_bucket.recordings[0].name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_storage_bucket_iam_member" "egress" {
  count  = local.live ? 1 : 0
  bucket = google_storage_bucket.recordings[0].name
  # Egress rewrites the HLS playlist as segments arrive.
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${var.livekit.egress_email}"
  condition {
    title      = "capture-objects"
    expression = "resource.name.startsWith('projects/_/buckets/${google_storage_bucket.recordings[0].name}/objects/captures/')"
  }
}

resource "google_cloud_run_v2_service" "api" {
  name                = "floorplan-ai"
  location            = local.region
  deletion_protection = false
  custom_audiences    = var.mobile_oauth == null ? [] : [var.mobile_oauth.client_id]
  # External HTTPS endpoint; Cloud Run IAM requires an authenticated invoker.
  ingress = "INGRESS_TRAFFIC_ALL"
  template {
    service_account = google_service_account.runtime.email
    timeout         = "900s"
    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }
    containers {
      name  = "api"
      image = "${local.repo}/api@${var.api_digest}"
      ports { container_port = 8080 }
      resources {
        limits   = { cpu = "2", memory = "4Gi" }
        cpu_idle = true
      }
      dynamic "env" {
        for_each = merge({
          GOOGLE_CLOUD_PROJECT    = local.project
          GOOGLE_MANAGED_AGENT_ID = "floorplan-review"
          LIVEKIT_KEEPALIVE       = local.live ? "true" : "false"
          }, local.lk_env, var.inspection == null ? {} : {
          INSPECTION_PUBLIC_ORIGIN        = var.inspection.job_origin
          INSPECTION_TASK_ORIGIN          = var.inspection.service_origin
          INSPECTION_TASK_QUEUE           = google_cloud_tasks_queue.evidence[0].id
          INSPECTION_TASK_SERVICE_ACCOUNT = google_service_account.tasks[0].email
        }, local.live ? { LIVEKIT_GCS_BUCKET = google_storage_bucket.recordings[0].name } : {})
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.secrets
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
    }
    dynamic "containers" {
      for_each = var.livekit[*]
      content {
        name  = "guide"
        image = "${local.repo}/worker@${containers.value.worker_digest}"
        resources {
          limits   = { cpu = "2", memory = "2Gi" }
          cpu_idle = true
        }
        dynamic "env" {
          for_each = merge(local.lk_env, {
            FLOORPLAN_SERVER_URL  = "http://127.0.0.1:8080"
            GOOGLE_CLOUD_PROJECT  = local.project
            GOOGLE_CLOUD_LOCATION = "us-central1"
          })
          content {
            name  = env.key
            value = env.value
          }
        }
        dynamic "env" {
          for_each = local.lk_auth
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret  = env.value
                version = "latest"
              }
            }
          }
        }
      }
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.reader, google_project_iam_member.vertex, google_storage_bucket_iam_member.drafts, google_storage_bucket_iam_member.egress]
}

resource "google_cloud_run_v2_service_iam_member" "mobile_invoker" {
  count    = var.mobile_oauth == null ? 0 : 1
  project  = local.project
  location = local.region
  name     = google_cloud_run_v2_service.api.name
  role     = "roles/run.invoker"
  member   = "user:${var.mobile_oauth.email}"
}

output "service_url" {
  value = google_cloud_run_v2_service.api.uri
}
