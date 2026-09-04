(() => {
  "use strict";

  const DEMO_ACCOUNT = Object.freeze({
    email: "demo@opencode.dev",
    password: "demo123",
    name: "ডেমো ব্যবহারকারী",
  });

  const loginSection = document.querySelector("#login-section");
  const successSection = document.querySelector("#success-section");
  const loginForm = document.querySelector("#login-form");
  const emailInput = document.querySelector("#email");
  const passwordInput = document.querySelector("#password");
  const emailError = document.querySelector("#email-error");
  const passwordError = document.querySelector("#password-error");
  const errorBanner = document.querySelector("#error-banner");
  const loadingSpinner = document.querySelector("#loading-spinner");
  const loginButton = document.querySelector("#login-btn");
  const logoutButton = document.querySelector("#logout-btn");
  const welcomeName = document.querySelector("#welcome-name");
  const welcomeEmail = document.querySelector("#welcome-email");

  function setVisible(element, visible) {
    element.classList.toggle("active", visible);
  }

  function setError(element, message) {
    element.textContent = message;
  }

  function clearErrors() {
    setError(emailError, "");
    setError(passwordError, "");
    setError(errorBanner, "");
    errorBanner.classList.remove("visible");
    emailInput.classList.remove("invalid");
    passwordInput.classList.remove("invalid");
  }

  function validateForm(email, password) {
    let valid = true;
    if (!email) {
      setError(emailError, "ইমেইল দিন।");
      emailInput.classList.add("invalid");
      valid = false;
    } else if (!emailInput.checkValidity()) {
      setError(emailError, "সঠিক ইমেইল ঠিকানা দিন।");
      emailInput.classList.add("invalid");
      valid = false;
    }
    if (!password) {
      setError(passwordError, "পাসওয়ার্ড দিন।");
      passwordInput.classList.add("invalid");
      valid = false;
    }
    return valid;
  }

  function showLogin() {
    setVisible(loginSection, true);
    setVisible(successSection, false);
    loadingSpinner.classList.remove("visible");
    loginButton.disabled = false;
    emailInput.focus();
  }

  function showSuccess() {
    welcomeName.textContent = DEMO_ACCOUNT.name;
    welcomeEmail.textContent = DEMO_ACCOUNT.email;
    setVisible(loginSection, false);
    setVisible(successSection, true);
  }

  loginForm.addEventListener("submit", (event) => {
    event.preventDefault();
    clearErrors();
    const email = emailInput.value.trim().toLowerCase();
    const password = passwordInput.value;
    if (!validateForm(email, password)) return;

    loginButton.disabled = true;
    loadingSpinner.classList.add("visible");

    window.setTimeout(() => {
      loadingSpinner.classList.remove("visible");
      loginButton.disabled = false;
      if (email === DEMO_ACCOUNT.email && password === DEMO_ACCOUNT.password) {
        showSuccess();
        return;
      }
      errorBanner.textContent = "ডেমো অ্যাকাউন্টের তথ্য মিলছে না। আবার চেষ্টা করুন।";
      errorBanner.classList.add("visible");
      passwordInput.value = "";
      passwordInput.focus();
    }, 250);
  });

  logoutButton.addEventListener("click", () => {
    loginForm.reset();
    clearErrors();
    showLogin();
  });

  emailInput.addEventListener("input", () => {
    emailInput.classList.remove("invalid");
    setError(emailError, "");
  });
  passwordInput.addEventListener("input", () => {
    passwordInput.classList.remove("invalid");
    setError(passwordError, "");
  });

  showLogin();
})();
