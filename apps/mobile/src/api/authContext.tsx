import { createContext, useContext, useEffect, useState, type PropsWithChildren } from "react";
import { useQueryClient } from "@tanstack/react-query";
import * as authApi from "./auth";
import { setUnauthorizedHandler } from "./client";
import { tokenStore } from "./tokenStore";

interface AuthContextValue {
  isSignedIn: boolean;
  isLoading: boolean;
  hasSelectedFacility: boolean;
  selectedFacility: { id: string; name: string } | null;
  signIn: (email: string, password: string) => Promise<void>;
  selectFacility: (facility: { id: string; name: string }) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const queryClient = useQueryClient();
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [hasSelectedFacility, setHasSelectedFacility] = useState(false);
  const [selectedFacility, setSelectedFacility] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    Promise.all([tokenStore.getAccessToken(), tokenStore.getSelectedFacility()]).then(([token, facility]) => {
      setIsSignedIn(!!token);
      setSelectedFacility(facility);
      setHasSelectedFacility(Boolean(token && facility));
      setIsLoading(false);
    });
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      queryClient.clear();
      setIsSignedIn(false);
      setHasSelectedFacility(false);
      setSelectedFacility(null);
    });
    return () => setUnauthorizedHandler(null);
  }, [queryClient]);

  const signIn = async (email: string, password: string) => {
    await authApi.login(email, password);
    queryClient.clear();
    setIsSignedIn(true);
    setHasSelectedFacility(false);
    setSelectedFacility(null);
    await tokenStore.clearSelectedFacility();
  };

  const selectFacility = async (facility: { id: string; name: string }) => {
    await tokenStore.setSelectedFacility(facility);
    queryClient.clear();
    setSelectedFacility(facility);
    setHasSelectedFacility(true);
  };

  const signOut = async () => {
    await authApi.logout();
    queryClient.clear();
    setIsSignedIn(false);
    setHasSelectedFacility(false);
    setSelectedFacility(null);
  };

  return (
    <AuthContext.Provider
      value={{ isSignedIn, isLoading, hasSelectedFacility, selectedFacility, signIn, selectFacility, signOut }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
