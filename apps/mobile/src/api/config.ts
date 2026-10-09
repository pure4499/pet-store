// iOS simulator can reach the host machine via localhost; Android emulator
// needs 10.0.2.2 instead, and a physical device needs the host's LAN IP.
// Override with `EXPO_PUBLIC_API_URL=http://<host>:3000` when running on
// Android or a physical device.
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3000";
