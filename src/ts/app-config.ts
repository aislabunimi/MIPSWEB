/**Configuration of the app, served by the server (see server.js) as mipsweb-config.json.
 * When the file is not available (e.g. static hosting) the defaults are used.*/
export type AppConfig = {
    /**"evaluator" enables the exam evaluator (launch the server with MIPSWEB_MODE=evaluator)*/
    mode: "normal" | "evaluator";
    /**default max number of executed instructions for each run of the evaluator (MIPSWEB_MAX_STEPS)*/
    evaluatorMaxSteps: number;
};

export const DEFAULT_EVALUATOR_MAX_STEPS = 1000;

export const appConfig: AppConfig = {
    mode: "normal",
    evaluatorMaxSteps: DEFAULT_EVALUATOR_MAX_STEPS,
};

export async function loadAppConfig(): Promise<AppConfig> {
    try {
        const res = await fetch("mipsweb-config.json", { cache: "no-store" });
        if (res.ok) {
            const config = await res.json();
            if (config.mode === "evaluator") appConfig.mode = "evaluator";
            const maxSteps = Number(config.evaluatorMaxSteps);
            if (Number.isInteger(maxSteps) && maxSteps > 0)
                appConfig.evaluatorMaxSteps = maxSteps;
        }
    } catch {
        // no configuration: defaults
    }
    return appConfig;
}

export function isEvaluatorMode(): boolean {
    return appConfig.mode === "evaluator";
}
