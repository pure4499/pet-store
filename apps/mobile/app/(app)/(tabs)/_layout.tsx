import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: "#176B5B",
        tabBarInactiveTintColor: "#7B8884",
        headerShown: false,
        tabBarStyle: { borderTopColor: "#E5E8E2" },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Pets",
          tabBarIcon: ({ color, size }) => <Ionicons name="paw-outline" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="photos"
        options={{
          title: "Capture",
          tabBarIcon: ({ color, size }) => <Ionicons name="camera-outline" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="check-in"
        options={{
          title: "Check In",
          tabBarIcon: ({ color, size }) => <Ionicons name="add-circle-outline" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: "More",
          tabBarIcon: ({ color, size }) => <Ionicons name="ellipsis-horizontal-circle-outline" color={color} size={size} />,
        }}
      />
      <Tabs.Screen name="coverage" options={{ href: null }} />
      <Tabs.Screen name="pets" options={{ href: null }} />
    </Tabs>
  );
}
