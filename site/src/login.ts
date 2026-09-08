import { getSupabaseClient } from "./supabaseClient";

const form = document.querySelector<HTMLFormElement>("#login-form")!;
const emailInput = document.querySelector<HTMLInputElement>("#email")!;
const statusEl = document.querySelector<HTMLElement>("#status")!;
const submitButton = form.querySelector<HTMLButtonElement>("button[type=submit]")!;

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = emailInput.value.trim();
  if (!email) return;

  submitButton.disabled = true;
  statusEl.textContent = "Sending your sign-in link...";

  try {
    const supabase = await getSupabaseClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${location.origin}/dashboard.html` },
    });
    if (error) {
      statusEl.textContent = `Something went wrong: ${error.message}`;
      submitButton.disabled = false;
      return;
    }
    statusEl.textContent = `Check ${email} for a sign-in link.`;
    form.hidden = true;
  } catch {
    statusEl.textContent = "Something went wrong. Please try again.";
    submitButton.disabled = false;
  }
});
