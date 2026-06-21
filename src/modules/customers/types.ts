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
