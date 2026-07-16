export async function resolve(specifier, context, nextResolve) {
  if (specifier === "node-llama-cpp" || specifier.startsWith("node-llama-cpp/")) {
    throw new Error(`native package resolution denied: ${specifier}`);
  }
  return nextResolve(specifier, context);
}
