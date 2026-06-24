export interface CustomerProfile {
  id: string;
  organizationId: string;
  storeId: string;
  name: string;
  phone?: string;
  email?: string;
  loyaltyAccountId?: string;
  pointsBalance?: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerSaveInput {
  id?: string | null;
  organizationId: string;
  storeId: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  isActive?: boolean;
}
