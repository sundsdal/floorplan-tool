# Deploy Floorplan AI to kin-shared

Run these commands from the root of this worktree. The GCP project **ID** is
`kinhelse-shared` (display name `kin-shared`); the Cloud Run region is
`europe-north1`. Terraform stores infrastructure state in separate
`floorplan-ai/bootstrap` and `floorplan-ai/runtime` prefixes of the existing
`kinhelse-shared-tfstate` bucket.

### First deployment

Authenticate `gcloud` and Terraform with an identity that can deploy in this
project and access the state bucket. Bootstrap the image repository, APIs and
Secret Manager entries before pushing the first image:

```sh
gcloud auth application-default login
gcloud auth configure-docker europe-north1-docker.pkg.dev
terraform -chdir=infra/terraform/bootstrap init
terraform -chdir=infra/terraform/bootstrap apply
```

Provision a dedicated Gemini auth key and send its raw value directly to
Secret Manager. It is restricted to the Gemini Developer API and bound to an
identity separate from the Cloud Run service:

```sh
key_id=floorplan-gemini-v2
gcloud services api-keys create --project=kinhelse-shared --key-id="$key_id" \
  --display-name="Floorplan Gemini" --api-target=service=generativelanguage.googleapis.com \
  --service-account=floorplan-gemini@kinhelse-shared.iam.gserviceaccount.com \
  --verbosity=error --format=none
set -o pipefail
gcloud services api-keys get-key-string "$key_id" --project=kinhelse-shared \
  --location=global --format='value(keyString)' | tr -d '\n' | \
  gcloud secrets versions add floorplan-gemini-key --data-file=- --project=kinhelse-shared
```

The preview Managed Agents API agent is provisioned once, outside Terraform.
Follow the [baseline provisioning instructions](../approaches/baseline/README.md#configure-a-test-project)
for `projects/kinhelse-shared/locations/global/agents/floorplan-review`.
This evaluation deployment is for synthetic or public footage only.

### Release the API

```sh
digest=$(bash infra/publish-image.sh api) &&
  printf 'api_digest = "%s"\n' "$digest" > infra/terraform/image.auto.tfvars
terraform -chdir=infra/terraform init
terraform -chdir=infra/terraform plan -out=release.tfplan
terraform -chdir=infra/terraform apply release.tfplan
```

The image includes FFmpeg and the standalone Next.js server. Requests go
through Cloud Run IAM. For a browser smoke test, run the following as a
principal with `roles/run.invoker` and open `http://localhost:8080`:

```sh
gcloud run services proxy floorplan-ai --project=kinhelse-shared --region=europe-north1 --port=8080
```

Cloud Run limits HTTP/1 request bodies to 32 MiB. Use a small video for the
multipart upload flow. Roll back by setting `api_digest` to a previous pushed
digest and applying the resulting plan.

Keep `infra/terraform/image.auto.tfvars` in version control: it records the
deployed image digest and contains no credentials.

### Enable the LiveKit guide and mobile capture

The API and guide scale to zero when idle. To use guided capture, supply a LiveKit project
with agent dispatch and participant Egress. Add secret versions using
`gcloud secrets versions add … --data-file=… --project=kinhelse-shared`:

| Secret | Value |
|---|---|
| `floorplan-livekit-key` / `floorplan-livekit-secret` | The LiveKit project's API key and secret, respectively |
| `floorplan-session-secret` | Random signing secret of at least 32 characters |
| `floorplan-egress-credentials` | Raw service account JSON for the Egress writer |

The deployed LiveKit project, worker digest, and recording-writer address are
recorded in `infra/terraform/livekit.auto.tfvars`. When releasing a new worker,
publish it with `bash infra/publish-image.sh worker` and update the digest:

```hcl
livekit = {
  url           = "wss://YOUR-LIVEKIT-ENDPOINT"
  worker_digest = "sha256:REPLACE_WITH_PUSHED_DIGEST"
  egress_email  = "REPLACE_WITH_CLIENT_EMAIL_FROM_EGRESS_JSON"
}
```

Plan and apply the runtime root again. Terraform creates a private recording
bucket with a seven-day object lifecycle and grants the writer scoped access.
The guide runs as a sidecar and calls the API over localhost. Both containers use
request-based CPU, with zero minimum instances and one maximum instance. The
mobile app holds a session-authenticated, four-minute HTTP request open and
renews it while capture is active, keeping CPU available to the guide. Closing
the guide cancels the request; network interruptions are retried. Cloud Run
enables this through `LIVEKIT_KEEPALIVE=true`; local deployments leave it unset
unless they also need request-based CPU. The API and worker share the dispatch name.
For a physical phone, use an authenticated gateway or a trusted tunnel to the
local proxy and point `EXPO_PUBLIC_API_URL` there; the app's session tokens
are distinct from Cloud Run IAM credentials.

The Google Sign-In iOS build can also call this service directly. Keep the
deployed `mobile_oauth` settings in an ignored `mobile-oauth.auto.tfvars` file
when applying Terraform. Its `client_id` is the Web OAuth client ID and its
`email` identifies the Google account with Cloud Run invocation access.
The iOS build settings are in the [mobile README](../approaches/baseline/mobile/README.md).

## Guided inspections

Enable the Cloud Tasks API with the bootstrap configuration. Set the optional Terraform `inspection` object with `job_origin` matching the iOS build’s approved Risikovurdering HTTPS origin and `service_origin` matching the canonical Cloud Run service URL. Both use origins without a trailing slash. Deploy the job service with its incremental PATCH endpoint before enabling linked mobile builds. Frame extraction uses authenticated Cloud Tasks requests, including while the phone is disconnected. The private capture bucket holds the session timeline and recording for its existing seven-day lifecycle. The visit stores accepted JPEGs with their source time.
