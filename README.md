# reeve-payments

Payment rails (Stripe, Xendit, mock) the broker bills through, test mode only.

Package `@reeve/rails` (the payment gateway). One `PaymentRail` interface with three rails: Stripe
(`STRIPE_SECRET_KEY`), Xendit (`XENDIT_SECRET_KEY`) and a mock. Test mode only: live keys are refused.
Only the broker in reeve-api holds these keys; they never reach the sandbox or the web app.

```bash
npm install
npm test
```

## The Reeve repos

| Repo | What it holds |
|---|---|
| [reeve-core](https://github.com/Reeve-Agents/reeve-core) | Shared domain model: rulebook schemas, domain packs, simulation views and the sample businesses. |
| [reeve-connectors](https://github.com/Reeve-Agents/reeve-connectors) | Connectors: Composio toolkits and MCP servers the broker acts through, plus CSV and app record readers. |
| [reeve-payments](https://github.com/Reeve-Agents/reeve-payments) | Payment rails (Stripe, Xendit, mock) the broker bills through, test mode only. |
| [reeve-runtime](https://github.com/Reeve-Agents/reeve-runtime) | The Python agent runtime that runs compiled rules inside the sandbox. |
| [reeve-api](https://github.com/Reeve-Agents/reeve-api) | Backend: HTTP API, Builder, Auditor, pipeline, sandbox, broker, receipts ledger, on-chain anchor and the CLI. |
| [reeve-web](https://github.com/Reeve-Agents/reeve-web) | Owner app, owner studio and developer studio (Vite + React). |
| [reeve-landing](https://github.com/Reeve-Agents/reeve-landing) | Landing page (Vite + React + GSAP). |

```
reeve-web ─┐                      ┌─ reeve-connectors (MCP, Composio)
reeve-landing ─┼─ reeve-core ─ reeve-api ─┼─ reeve-payments (Stripe, Xendit)
               │   (schemas,       │      └─ reeve-runtime (Python, submodule)
               │    packs,         │
               │    fixtures)      └─ /api over HTTP ── reeve-web
```

## Working across repos

Shared packages are installed straight from GitHub (`"@reeve/core": "github:Reeve-Agents/reeve-core#main"`) and pinned by
`package-lock.json`. After a change lands in one of them, pull it in with:

```bash
npm update @reeve/core
```

To edit two repos side by side, clone them next to each other and link the local copy:

```bash
npm install ../reeve-core --no-save
```
