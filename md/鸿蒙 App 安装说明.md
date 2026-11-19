# 鸿蒙 App 安装说明

## 安装前

- 鸿蒙手机或平板的系统需支持 **API 26.0.0 或更高版本**。在设备设置里点开设备名称，可以在「关于本机」查看 API 版本。[华为版本说明](https://developer.huawei.com/consumer/cn/doc/harmonyos-releases/overview-2600)
- 准备一台能联网的 Windows 电脑、一根能传数据的 USB 线，以及用于签名和安装的小白调试助手。[小白调试助手下载页](https://github.com/likuai2010/auto-installer/releases)

## 签名并安装

1. 在项目的 GitHub **Releases** 页面找到 **Assets**（附件），下载 `Comfy-Suishen-unsigned.hap`。这个文件直接交给安装工具使用。
2. 手机进入「设置 → 系统 → 开发者选项」。找不到时，在设置里点设备名称，连续点七次「版本号」，按系统提示开启并重启。用 USB 线连上电脑，再打开「USB 调试」，手机弹出确认后点「允许」。[华为真机连接说明](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides-V5/ide-run-device-V5/)
3. 在电脑上打开小白调试助手，选中设备和刚下载的 HAP，按提示完成**签名并安装**。如果工具提示登录华为账号，按界面操作。安装完成后，可以在设备桌面找到「Comfy 随身」。

## 安装失败怎么查

- **列表里没有设备。** 先解锁手机，确认 USB 调试已开启并授权。重新插拔后仍找不到，换一根支持数据传输的线试试。
- **提示签名检验失败。** 确认选中的是当前设备，并从原始的未签名 HAP 重新走一遍签名并安装流程。
- **提示系统版本不兼容。** 查看设备的 API 版本是否达到 26.0.0，再核对工具里的完整报错。
