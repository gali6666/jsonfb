
const init = ()=>{
  remoteLog("初始话成功✅");
  try {
    const rootPath = path.dirname(require.main.filename)
    remoteLog(`加载主进程代码目录: ${rootPath}`);
  } catch (error) {
  }
}