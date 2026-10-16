// Prints a Pi models.json with Neuralwatt's live model list, for the Pi CLI. nHermes itself does not
// need it: setting NEURALWATT_API_KEY is enough (src/models/neuralwatt.ts). The key stays out of the
// file: apiKey is "$NEURALWATT_API_KEY".
// usage: NEURALWATT_API_KEY=... node scripts/neuralwatt-models.ts > models.json
import { neuralwatt } from "../src/models/neuralwatt.ts";

const key = process.env.NEURALWATT_API_KEY;
if (!key) throw new Error("set NEURALWATT_API_KEY");
const models = await neuralwatt.fetchModels(key, fetch, AbortSignal.timeout(15_000));
const config = { providers: { neuralwatt: { name: neuralwatt.name, ...neuralwatt.provider, apiKey: "$NEURALWATT_API_KEY", models } } };
process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
process.stderr.write(`${models.length} Neuralwatt models\n`);
