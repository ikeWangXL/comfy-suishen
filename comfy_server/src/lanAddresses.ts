import os from "node:os";

// 虚拟网卡（WSL、Hyper-V、Docker、VMware 等）只在本机可达，局域网设备连不上；
// 混进地址列表还会随虚拟网卡启停触发证书重新生成，导致已配对设备全部失效。
const VIRTUAL_ADAPTER_PATTERN = /virtual|vmware|virtualbox|hyper[- ]?v|vEthernet|wsl|docker|default switch|tap|tun|loopback/i;

function isPrivateIpv4(address: string): boolean {
  const [first, second] = address.split(".").map(Number);
  return first === 10 || first === 172 && second >= 16 && second <= 31 ||
    first === 192 && second === 168 || first === 169 && second === 254;
}

export function lanIpv4Addresses(): string[] {
  const found = new Set<string>();
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_ADAPTER_PATTERN.test(name)) continue;
    for (const item of addresses ?? []) {
      if (item.family === "IPv4" && !item.internal && isPrivateIpv4(item.address)) {
        found.add(item.address);
      }
    }
  }
  return [...found].sort();
}
