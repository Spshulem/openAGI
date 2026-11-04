// Paseo 0.15 supports interrupt or steer, and steer can fall back to
// interruption. A refresh followed by send cannot protect a racing active job.
// Fail closed until the public API offers an atomic idle-only send condition.
export async function deliverPaseo({ actionId }) {
  return {
    status: "blocked", route: "paseo-send", actionId,
    detail: "Paseo automatic delivery requires an atomic idle-only send API; use the existing chat"
  };
}
