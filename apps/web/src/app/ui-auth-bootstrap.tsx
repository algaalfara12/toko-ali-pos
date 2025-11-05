"use client";
import { useEffect } from "react";
import { useAuth } from "@/store/auth";

export default function AuthBootstrap() {
  const init = useAuth((s) => s.initFromStorage);
  useEffect(() => {
    init();
  }, [init]);
  return null;
}
