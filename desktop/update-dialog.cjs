'use strict';
// Native dialogs avoid modifying the bundled upstream renderer. Taskbar progress is
// updated by the main process while the user-requested download runs.
function createUpdateDialog({ service, dialog, shell, getWindow }) {
  let showing = false;
  const show = async (options) => {
    const win = getWindow();
    return win && !win.isDestroyed() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
  };
  const openLink = async url => {
    try { await shell.openExternal(url); }
    catch { await show({ type: 'error', title: '打开下载页失败', message: '浏览器未能打开，请复制以下地址到浏览器，或稍后重试。', detail: url, buttons: ['确定'] }); }
  };
  return async function showUpdates() {
    if (showing) return service.getState();
    showing = true;
    try {
      let state = service.getState();
      if (state.status !== 'downloaded' && state.status !== 'downloading') state = await service.check();
      if (state.downloadMode === 'browser' && state.status === 'available') {
        const result = await show({ type: 'info', title: '小克更新', message: state.message, detail: `${state.notes || ''}\n\n下载安装后运行向导完成更新。`, buttons: ['下载安装包', '发布说明', '稍后'], cancelId: 2 });
        if (result.response === 0) await openLink(state.downloadUrl);
        else if (result.response === 1) await openLink(state.releaseUrl);
        return state;
      }
      if (state.status === 'error' && state.releaseUrl) {
        const result = await show({ type: 'error', title: '检查更新失败', message: state.message, buttons: ['打开发布页', '关闭'], cancelId: 1 });
        if (result.response === 0) await openLink(state.releaseUrl);
        return state;
      }
      if (state.status === 'available') {
        const result = await show({ type: 'info', title: '小克更新', message: state.message, buttons: ['下载更新', '稍后'], cancelId: 1 });
        if (result.response !== 0) return state;
        state = await service.download();
      }
      if (state.status === 'downloaded') {
        const result = await show({ type: 'info', title: '小克更新', message: state.message, detail: '安装由 NSIS 向导执行。安装成功后重新打开应用；失败时当前版本仍可使用。', buttons: [state.canInstall ? '运行安装程序' : '在文件夹中查看', '稍后'], cancelId: 1 });
        if (result.response === 0) {
          if (state.canInstall) {
            state = await service.install();
            if (state.status === 'error') await show({ type: 'error', title: '更新失败', message: state.message, buttons: ['确定'] });
          } else shell.showItemInFolder(service.file);
        }
      } else await show({ type: state.status === 'error' ? 'error' : 'info', title: '小克更新', message: state.message, buttons: ['确定'] });
      return state;
    } finally { showing = false; }
  };
}
module.exports = { createUpdateDialog };
