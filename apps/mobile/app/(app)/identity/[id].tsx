import { useLocalSearchParams, useRouter } from "expo-router";
import { ActivityIndicator, View } from "react-native";
import { IdentityEnrollmentScreen } from "../(tabs)/check-in";
import { useSession } from "../../../src/api/hooks";

export default function IdentityEnrollmentRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { data: session } = useSession(id);
  if (!session) return <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><ActivityIndicator /></View>;
  return <IdentityEnrollmentScreen
    pet={{ id: session.pet_id, name: session.pet_name }}
    sessionId={id}
    doneLabel="Done"
    onDone={() => router.back()}
  />;
}
