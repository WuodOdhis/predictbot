import './network.js';
import { askModel as requestForecast } from '../shared/models.js';

export { parseForecast } from '../shared/models.js';
export function askModel(model: string, context: unknown, seconds: number) {
  return requestForecast(model, context, seconds, process.env.GROQ_API_KEY);
}
