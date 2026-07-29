# ecommerce-k8s-manifests

GitOps source of truth for the `ecommerce` namespace on the local Minikube cluster.
ArgoCD watches the `manifests/` directory and auto-syncs any change pushed here.

## Layout

- `manifests/` — everything ArgoCD applies to the cluster (Deployments, Services, ConfigMaps, Secrets, Ingress).
- `argocd/application.yaml` — the ArgoCD `Application` resource itself. Applied once manually
  (`kubectl apply -f argocd/application.yaml`) to bootstrap GitOps; not part of the synced path.

## Workflow

1. Edit a YAML file in `manifests/` (e.g. change `replicas` in `order-service.yaml`).
2. Commit and push to `main`.
3. ArgoCD detects the diff, marks the app `OutOfSync`, and auto-syncs within ~3 minutes
   (or immediately if you click "Refresh" in the ArgoCD UI).

No `kubectl apply` needed after the initial bootstrap.
