PROFILE_MANAGEMENT ?= management
PROFILE_PRODUCTION ?= production
GH_ORG         ?= erwan-jouan
GITHUB_REPO        ?= *
OIDC_STACK_NAME    ?= GitHubOIDC

# ─── OIDC setup (run once before the GitHub Actions workflow) ─────────────────

# Deploy the GitHub OIDC provider + IAM role to the management account.
deploy-oidc-management:
	source .env && \
	aws cloudformation deploy \
		--template-file ./github-oidc/cf-github-oidc.yml \
		--stack-name $(OIDC_STACK_NAME) \
		--capabilities CAPABILITY_NAMED_IAM \
		--parameter-overrides \
			  GitHubOrg=$(GH_ORG) \
			  GitHubRepo=$(GITHUB_REPO) \
			  RoleName=$${GH_ACTIONS_ROLE_NAME} \
		--no-fail-on-empty-changeset \
		--profile $(PROFILE_MANAGEMENT)

# Deploy the GitHub OIDC provider + IAM role to the production account.
deploy-oidc-production:
	source .env && \
	aws cloudformation deploy \
		--template-file ./github-oidc/cf-github-oidc.yml \
		--stack-name $(OIDC_STACK_NAME) \
		--capabilities CAPABILITY_NAMED_IAM \
		--parameter-overrides \
			GitHubOrg=$(GH_ORG) \
			GitHubRepo=$(GITHUB_REPO) \
			RoleName=$${GH_ACTIONS_ROLE_NAME} \
		--no-fail-on-empty-changeset \
		--profile $(PROFILE_PRODUCTION)

# Deploy to both accounts (management first, though order doesn't matter here).
deploy-oidc: deploy-oidc-management deploy-oidc-production

upload-secrets:
	gh auth refresh -h github.com -s admin:org && \
	gh secret set --app actions --env-file .env --org $(GH_ORG) \
		--visibility all

cdk-common-synth:
	...