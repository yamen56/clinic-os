"use client";

import { createContext, useContext, useMemo } from "react";
import { mergeCatalog, type FaceTreatment, type TreatmentLook } from "@/lib/charts/face/catalog";

/*
  The face chart's treatments with the clinic's own (0094), for the screens
  outside the chart that list them: prices, packages, products. The page that
  loads the clinic's treatments wraps its client in this, and every list inside
  reads the same merged catalog.
*/

const Ctx = createContext(mergeCatalog([]));

export function FaceCatalogProvider({ custom, looks = [], children }: { custom: FaceTreatment[]; looks?: TreatmentLook[]; children: React.ReactNode }) {
  // A treatment the clinic removed (0098) is not offered here either.
  const value = useMemo(() => mergeCatalog(custom, looks), [custom, looks]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useFaceCatalog = () => useContext(Ctx);
