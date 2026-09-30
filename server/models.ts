import { z } from 'zod';
import './network.js';

const resultSchema = z.object({
  prediction: z.number().int().min(0).max(1_000_000_000),
  reasoning: z.string().min(1).max(2000),
});
export function parseForecast(text: string) {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/, '')
    .replace(/\s*```$/, '');
  return resultSchema.parse(JSON.parse(cleaned));
}
export async function askModel(model: string, context: unknown, seconds: number) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY is not configured.');
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(45_000),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_completion_tokens: 2048,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You forecast blockchain transaction counts. Use only the supplied data. Return a JSON object with prediction (nonnegative integer total transaction count) and reasoning (brief string). Do not claim access to additional live data.',
        },
        {
          role: 'user',
          content: `Predict the total number of BOT testnet transactions during the upcoming ${seconds}-second observation window. All transactions count, including reverted ones. Both competitors receive this same recent block sample: ${JSON.stringify(context)}`,
        },
      ],
    }),
  });
  if (!response.ok)
    throw new Error(
      `Model provider returned HTTP ${response.status}. Check credentials, model availability, or quota.`,
    );
  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
    model?: string;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Model returned no forecast.');
  return { ...parseForecast(content), reportedModel: data.model || model };
}
