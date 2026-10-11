import "./moon.css";

try {
  await import("./moon-main.js");
} catch (error) {
  const loading = document.getElementById("loading-state");
  const errorState = document.getElementById("error-state");
  const message = document.getElementById("error-message");
  if (loading) loading.hidden = true;
  if (errorState) errorState.hidden = false;
  if (message) {
    message.textContent = error instanceof Error
      ? error.message
      : "The lunar surface could not be created.";
  }
  throw error;
}
