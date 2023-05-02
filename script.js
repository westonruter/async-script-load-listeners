document.getElementById("output").textContent += "Async script evaluated\n";

const myAsyncLib = window.myAsyncLib = window.myAsyncLib || [];

myAsyncLib.log = (source) => {
  document.getElementById(
    "output"
  ).textContent += `Async script\'s function called by ${source}\n`;
}

for (const callback of window.myAsyncLib) {
  callback(myAsyncLib);
}
window.myAsyncLib.push = (callback) => {
  callback(myAsyncLib);
};
