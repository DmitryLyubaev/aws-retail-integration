export const compiledTests = () => process.env.COMPILED_TESTS === "true";
export const runtimePath = (script: string) =>
  compiledTests() ? "dist/" + script.replace(/\.ts$/, ".js") : script;
export const runtimeArgs = (script: string) =>
  compiledTests() ? [runtimePath(script)] : ["--import", "tsx", script];
