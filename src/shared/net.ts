import net from "node:net";

// Probed by connecting, because SO_REUSEADDR lets a test bind succeed while another listener holds the port
export async function isPortInUse(port: number): Promise<boolean> {
  const results = await Promise.all(["127.0.0.1", "::1"].map((host) => isConnectable(host, port)));
  return results.includes(true);
}

async function isConnectable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.unref();
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      resolve(false);
    });
  });
}
