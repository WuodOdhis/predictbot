# Forecast Arena

**An AI prediction time capsule on BOT Chain.**

**[Open the live app](https://predictbot-flax.vercel.app)**

Forecast Arena lets two AI models predict the same future outcome, locks in their answers before the event, and compares those predictions with what actually happened. Over repeated rounds, it builds a public record of their performance.

The first experiment is simple: **how many transactions will BOT testnet process during the next observation window?**

Instead of judging an AI by a convincing explanation, the arena gives it a question with a measurable answer. You can follow the round, see both forecasts when they are revealed, and check which model came closest.

## How a round works

1. **Choose a window.** Open a round with a 1-, 5-, or 10-minute observation period.
2. **Both models make a forecast.** They receive the same recent network activity data and the same instructions.
3. **The answers are sealed.** A digital fingerprint of each prediction is recorded on BOT testnet. The submitted prediction cannot be replaced with a different answer when it is revealed.
4. **The predictions are revealed.** Submissions close, then each model's predicted transaction count and explanation become visible before observation starts.
5. **The arena watches the outcome.** It counts the transactions during the agreed period and publishes the supporting block records.
6. **The forecasts are scored.** The closest prediction wins. Ties share the win, and the results feed into the leaderboard.

For example, if one model predicts 12 transactions and another predicts 18, an actual count of 15 gives both an error of 3. They tie. This is an illustration of scoring, not a recorded round.

A one-minute on-chain round takes roughly five minutes overall because sealing, revealing, and confirming the result also take time.

## What you can explore

| View | What you will find |
| --- | --- |
| **Arena** | The current question, round countdown, sealed or revealed predictions, model explanations, and the final result. |
| **Activity** | A timeline of commitments, reveals, settlement, and missed deadlines. |
| **Round history** | Previous rounds, their outcomes, and cancelled rounds. |
| **Leaderboard** | Average prediction error, wins, scored rounds, and missed reveals for each participant. Lower error ranks higher. |
| **Network pulse** | Live samples of BOT testnet activity and a link to its explorer. |
| **Settings** | The status of the model provider, signing wallet, and arena contract. |

Every round has published rules. Once it is settled, you can also inspect the block evidence used to calculate its outcome. Missed reveals remain visible rather than disappearing from the record.

## The competitors

The default AI competitors are **GPT-OSS 120B** and **GPT-OSS 20B**, accessed through Groq. Both work from the same supplied data; neither is given extra browsing or live-data tools.

There are two ways to run the arena:

- **On-chain AI:** real model forecasts, with their sealed submissions and settlement recorded on BOT testnet.
- **Local practice:** two statistical baselines, called Recent mean and Block median, forecast against real testnet outcomes. This mode works without model credentials or a funded wallet. Its commitments are stored locally, and its results have a separate leaderboard.

## Why use a blockchain?

A prediction is only meaningful if it was made before the outcome was known.

BOT testnet gives each submitted commitment a public transaction record. When the answer is revealed, it can be checked against that earlier commitment. This makes it possible to detect an answer that was changed after submission.

The blockchain does **not** prove that a particular AI generated the answer or that the reported outcome is correct. The current app's backend runs the models and reports the outcome, with supporting records available for inspection.

## Where the project stands

Forecast Arena is a working testnet prototype. The public website is hosted on Vercel, its round worker and persistent storage run on Cloudflare's free Workers tier, and the arena contract is deployed on **BOT testnet, chain 968**. You can also run the app locally.

**[View the deployed contract on BOTScan](https://scan.bohr.life/address/0xcd8da7961c607ad246dfb4a74ba2d07de38df346)**

The current version supports one active round at a time and the transaction-count experiment described above. It does not yet accept custom questions or outside agents. There are no bets, cash prizes, or token payments; test BOT is used for on-chain transaction fees.

The hosted backend wakes up automatically to reveal forecasts and collect results, even when the website is closed. **Reviewers can open a one-minute AI round without a token.** Public access allows one active round at a time, up to 12 attempts per UTC day across all visitors, and a 60-second cooldown between attempts. Failed attempts also count toward that allowance. The app shows the remaining public allowance.

Cancellation, worker retries, data imports, and the full operator settings still require operator access. Cancelled rounds remain in history. When running locally, keep the backend running throughout a round.

## Try it locally

With Node.js 20+ and npm installed:

```bash
npm install
npm run dev
```

Open **http://localhost:5173**, choose **New round**, select **Local practice**, and open a one-minute round. Practice mode still needs a working connection to BOT testnet.

To enable real AI rounds, you will need a Groq API key, a funded testnet wallet, and an arena contract controlled by that wallet. The existing deployed contract is controlled by this project's operator wallet; a new wallet needs its own deployment.

For configuration, deployment, testing, and verification details, see the **[Developer Guide](docs/DEVELOPMENT.md)**.
