const { app, nativeImage } = require('electron');
const fs=require('fs'), path=require('path');
if (process.env.ELECTRON_RUN_AS_NODE === '1') delete process.env.ELECTRON_RUN_AS_NODE;
app.whenReady().then(() => {
  const img = nativeImage.createFromPath(path.join(__dirname,'../evidence/icons-check.png'));
  const size = img.getSize();
  // Account row sits at the bottom-left of the sidebar.
  const rect = { x: 0, y: size.height - 40, width: 240, height: 40 };
  const cropped = img.crop(rect).resize({ width: 240*4, height: 40*4, quality: 'best' });
  fs.writeFileSync(path.join(__dirname,'../evidence/crop-mark.png'), cropped.toPNG());
  console.log('cropped', JSON.stringify(rect), 'from', JSON.stringify(size));
  app.exit(0);
});
