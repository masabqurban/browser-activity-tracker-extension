function nowTimestamp() {
  return Date.now();
}

function domainFromUrl(url) {
  try {
    return new URL(url).hostname || "unknown";
  } catch {
    return "unknown";
  }
}
