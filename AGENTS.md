# Repository Guidelines

## Project Structure & Module Organization
- Core entry: `plugin.rb` wires routes, assets, and initializers.
- Ruby backend: `app/controllers/discourse_siwe/*`, `lib/discourse_siwe/*`, and `lib/omniauth/strategies/siwe.rb` (OmniAuth strategy).
- Frontend (Discourse/Ember): `assets/javascripts/discourse/**` (routes, controllers, templates) and styles in `assets/stylesheets/*.scss`.
- Translations and settings: `config/locales/*.yml`, `config/settings.yml`.
- Static assets: `public/javascripts` and top-level images used in docs/UI.

## Build, Test, and Development Commands
This is a Discourse plugin. Develop and run it inside a Discourse core checkout:
- Install for dev: from Discourse root: `git clone <this repo> plugins/discourse-siwe-auth`.
- Run Discourse dev: from core: `bin/dev` (or `bundle exec rails server` if not using the dev script).
- Ruby specs: `bin/rake plugin:spec[discourse-siwe-auth]`.
- JS/QUnit: `bin/rake plugin:qunit[discourse-siwe-auth]`.
Note: Commands run from the Discourse core directory, not this repo.

## Coding Style & Naming Conventions
- Ruby: 2-space indent, frozen string literals, `snake_case` methods/files, controllers under `app/controllers/.../*_controller.rb`.
- JS/Ember: 2-space indent, `camelCase` for vars/functions, `PascalCase` for classes. File names follow existing `*.js.es6`/`*.hbs` patterns.
- SCSS: use variables from Discourse theme (e.g., `var(--secondary)`), keep selectors scoped (e.g., `.eth_provider_*`).

## Testing Guidelines
- Add Ruby specs under `spec/plugins/discourse-siwe-auth/` and JS tests under `plugins:qunit` paths mirroring `assets/javascripts/discourse/**`.
- Prefer request specs for OmniAuth flows and unit specs for helpers/strategy behavior.
- Keep tests deterministic; mock external Ethereum/Web3 calls.

## Commit & Pull Request Guidelines
- Commit messages: short imperative subject, optional scope (e.g., `fix(auth): handle invalid signature`).
- PRs must include: summary of change, motivation, screenshots/GIFs for UI, and linked issues/Discourse topics.
- Keep changes focused; separate refactors from functional changes when possible.

## Security & Configuration Tips
- Site settings live in `config/settings.yml`; validate presence server-side before using.
- Never log secrets, signatures, or wallet addresses at info level.
- When integrating RPC providers, ensure hosts are whitelisted via Discourse settings and sanitize user input.
