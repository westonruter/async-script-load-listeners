document.getElementById("output").textContent += "🔵 Script evaluated\n";

const myAsyncLib = window.myAsyncLib = window.myAsyncLib || [];

myAsyncLib.log = (source) => {
  document.getElementById(
    "output"
  ).textContent += `✅ Script\'s function called by ${source}\n`;
}

for (const callback of window.myAsyncLib) {
  callback(myAsyncLib);
}
window.myAsyncLib.push = (callback) => {
  callback(myAsyncLib);
};
