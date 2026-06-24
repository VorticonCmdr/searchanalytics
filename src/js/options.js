import 'bootstrap/dist/css/bootstrap.min.css';

document.addEventListener("DOMContentLoaded", () => {
  chrome.storage.sync.get({ idRegex: "" }, (items) => {
    document.getElementById("idRegex").value = items.idRegex;
  });
});

document.getElementById("save").addEventListener("click", () => {
  const regex = document.getElementById("idRegex").value;
  chrome.storage.sync.set({ idRegex: regex }, () => {
    const status = document.getElementById("status");
    status.textContent = "Settings saved.";
    setTimeout(() => {
      status.textContent = "";
    }, 2000);
  });
});
