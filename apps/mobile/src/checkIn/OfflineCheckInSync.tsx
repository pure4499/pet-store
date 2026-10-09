import NetInfo from "@react-native-community/netinfo";
import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";
import { useEffect } from "react";
import { AppState, Platform } from "react-native";
import { queryClient } from "../lib/queryClient";
import { processPendingCheckIns } from "./offlineCheckInQueue";

const TASK_NAME = "tail-tells-check-in-sync";

if (Platform.OS !== "web") {
  TaskManager.defineTask(TASK_NAME, async () => {
    try {
      await processPendingCheckIns();
      return BackgroundTask.BackgroundTaskResult.Success;
    } catch {
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}

async function syncAndRefresh() {
  const result = await processPendingCheckIns();
  if (result.completed.size > 0) {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["sessions"] }),
      queryClient.invalidateQueries({ queryKey: ["pending-check-ins"] }),
      queryClient.invalidateQueries({ queryKey: ["collar-palette"] }),
    ]);
  } else {
    await queryClient.invalidateQueries({ queryKey: ["pending-check-ins"] });
  }
}

export function OfflineCheckInSync() {
  useEffect(() => {
    if (Platform.OS !== "web") {
      void BackgroundTask.registerTaskAsync(TASK_NAME, { minimumInterval: 15 }).catch(() => undefined);
    }
    void syncAndRefresh();
    const unsubscribeNetwork = NetInfo.addEventListener((state) => {
      if (state.isConnected && state.isInternetReachable !== false) void syncAndRefresh();
    });
    const appStateSubscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void syncAndRefresh();
    });
    return () => {
      unsubscribeNetwork();
      appStateSubscription.remove();
    };
  }, []);
  return null;
}
