export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface Database {
  public: {
    Tables: {
      platform_settings: {
        Row: {
          id: string;
          billing_provider: "promptpay" | "stripe";
          promptpay_id: string | null;
          promptpay_name: string | null;
          promptpay_static_payload: string | null;
          updated_by: string | null;
          updated_at: string;
        };
        Insert: {
          id?: string;
          billing_provider?: "promptpay" | "stripe";
          promptpay_id?: string | null;
          promptpay_name?: string | null;
          promptpay_static_payload?: string | null;
          updated_by?: string | null;
          updated_at?: string;
        };
        Update: {
          id?: string;
          billing_provider?: "promptpay" | "stripe";
          promptpay_id?: string | null;
          promptpay_name?: string | null;
          promptpay_static_payload?: string | null;
          updated_by?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      payment_submissions: {
        Row: {
          id: string;
          organization_id: string;
          plan: "starter" | "standard" | "premium";
          duration: "30d" | "1y";
          amount_expected: number;
          verified_amount: number | null;
          slip_ref: string | null;
          slip_image_path: string | null;
          slip2go_raw: Json | null;
          status: "pending" | "verified" | "rejected" | "duplicate";
          reason: string | null;
          submitted_by: string | null;
          created_at: string;
          verified_at: string | null;
        };
        Insert: {
          id?: string;
          organization_id: string;
          plan: "starter" | "standard" | "premium";
          duration: "30d" | "1y";
          amount_expected: number;
          verified_amount?: number | null;
          slip_ref?: string | null;
          slip_image_path?: string | null;
          slip2go_raw?: Json | null;
          status?: "pending" | "verified" | "rejected" | "duplicate";
          reason?: string | null;
          submitted_by?: string | null;
          created_at?: string;
          verified_at?: string | null;
        };
        Update: {
          id?: string;
          organization_id?: string;
          plan?: "starter" | "standard" | "premium";
          duration?: "30d" | "1y";
          amount_expected?: number;
          verified_amount?: number | null;
          slip_ref?: string | null;
          slip_image_path?: string | null;
          slip2go_raw?: Json | null;
          status?: "pending" | "verified" | "rejected" | "duplicate";
          reason?: string | null;
          submitted_by?: string | null;
          created_at?: string;
          verified_at?: string | null;
        };
        Relationships: [];
      };
      billing_premium_trial_redemptions: {
        Row: {
          id: string;
          organization_id: string;
          user_id: string;
          promotion_code: string;
          plan: "premium";
          duration: "30d";
          amount_expected: number;
          amount_charged: 0;
          redeemed_at: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          user_id: string;
          promotion_code?: string;
          plan: "premium";
          duration: "30d";
          amount_expected: number;
          amount_charged?: 0;
          redeemed_at?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          user_id?: string;
          promotion_code?: string;
          plan?: "premium";
          duration?: "30d";
          amount_expected?: number;
          amount_charged?: 0;
          redeemed_at?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      buffet_packages: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          name: string;
          price_per_guest: number;
          duration_minutes: number | null;
          active: boolean;
          sort_order: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          name: string;
          price_per_guest: number;
          duration_minutes?: number | null;
          active?: boolean;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          store_id?: string;
          name?: string;
          price_per_guest?: number;
          duration_minutes?: number | null;
          active?: boolean;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      billing_prices: {
        Row: {
          tier: "starter" | "standard" | "premium";
          duration: "30d" | "1y";
          amount: number;
          updated_at: string;
        };
        Insert: {
          tier: "starter" | "standard" | "premium";
          duration: "30d" | "1y";
          amount: number;
          updated_at?: string;
        };
        Update: {
          tier?: "starter" | "standard" | "premium";
          duration?: "30d" | "1y";
          amount?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      billing_promotions: {
        Row: {
          id: string;
          description: string;
          percent_off: number;
          active: boolean;
          plan: "starter" | "standard" | "premium" | null;
          starts_at: string | null;
          ends_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          description: string;
          percent_off: number;
          active?: boolean;
          plan?: "starter" | "standard" | "premium" | null;
          starts_at?: string | null;
          ends_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          description?: string;
          percent_off?: number;
          active?: boolean;
          plan?: "starter" | "standard" | "premium" | null;
          starts_at?: string | null;
          ends_at?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      plan_settings: {
        Row: {
          tier: "starter" | "standard" | "premium" | "enterprise";
          display_name: string;
          visible_on_landing: boolean;
          highlight: boolean;
          feature_lines: Json;
          sort_order: number;
          updated_at: string;
        };
        Insert: {
          tier: "starter" | "standard" | "premium" | "enterprise";
          display_name: string;
          visible_on_landing?: boolean;
          highlight?: boolean;
          feature_lines?: Json;
          sort_order?: number;
          updated_at?: string;
        };
        Update: {
          tier?: "starter" | "standard" | "premium" | "enterprise";
          display_name?: string;
          visible_on_landing?: boolean;
          highlight?: boolean;
          feature_lines?: Json;
          sort_order?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      organizations: {
        Row: {
          id: string;
          name: string;
          slug: string;
          owner_id: string;
          logo_url: string | null;
          suspended_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          slug: string;
          owner_id: string;
          logo_url?: string | null;
          suspended_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          slug?: string;
          owner_id?: string;
          logo_url?: string | null;
          suspended_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      subscriptions: {
        Row: {
          id: string;
          organization_id: string;
          plan: "free" | "starter" | "standard" | "premium" | "enterprise";
          status: "active" | "trialing" | "past_due" | "incomplete" | "incomplete_expired" | "unpaid" | "canceled" | "paused";
          stripe_subscription_id: string | null;
          stripe_price_id: string | null;
          current_period_start: string;
          current_period_end: string;
          cancel_at_period_end: boolean;
          trial_end: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          plan?: "free" | "starter" | "standard" | "premium" | "enterprise";
          status?: "active" | "trialing" | "past_due" | "incomplete" | "incomplete_expired" | "unpaid" | "canceled" | "paused";
          stripe_subscription_id?: string | null;
          stripe_price_id?: string | null;
          current_period_start?: string;
          current_period_end?: string;
          cancel_at_period_end?: boolean;
          trial_end?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          plan?: "free" | "starter" | "standard" | "premium" | "enterprise";
          status?: "active" | "trialing" | "past_due" | "incomplete" | "incomplete_expired" | "unpaid" | "canceled" | "paused";
          stripe_subscription_id?: string | null;
          stripe_price_id?: string | null;
          current_period_start?: string;
          current_period_end?: string;
          cancel_at_period_end?: boolean;
          trial_end?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      billing_customers: {
        Row: {
          id: string;
          organization_id: string;
          stripe_customer_id: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          stripe_customer_id: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          stripe_customer_id?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      billing_events: {
        Row: {
          id: string;
          stripe_event_id: string;
          event_type: string;
          status: string;
          processing_started_at: string | null;
          processing_attempt_id: string | null;
          processed_at: string | null;
          failed_at: string | null;
          last_error: string | null;
        };
        Insert: {
          id?: string;
          stripe_event_id: string;
          event_type: string;
          status?: string;
          processing_started_at?: string | null;
          processing_attempt_id?: string | null;
          processed_at?: string | null;
          failed_at?: string | null;
          last_error?: string | null;
        };
        Update: {
          id?: string;
          stripe_event_id?: string;
          event_type?: string;
          status?: string;
          processing_started_at?: string | null;
          processing_attempt_id?: string | null;
          processed_at?: string | null;
          failed_at?: string | null;
          last_error?: string | null;
        };
        Relationships: [];
      };
      system_accounts: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          kind: "qr_order";
          display_name: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          kind: "qr_order";
          display_name: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          store_id?: string;
          kind?: "qr_order";
          display_name?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      stores: {
        Row: {
          id: string;
          organization_id: string;
          name: string;
          slug: string;
          address: string | null;
          phone: string | null;
          logo_url: string | null;
          currency_code: string;
          timezone: string;
          locale: string;
          is_active: boolean;
          buffet_enabled: boolean;
          qr_ordering_enabled: boolean;
          dine_in_duration_minutes: number;
          theme_preset_id: string;
          theme_primary_color: string;
          theme_primary_strong_color: string;
          theme_primary_soft_color: string;
          theme_accent_color: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          name: string;
          slug: string;
          address?: string | null;
          phone?: string | null;
          logo_url?: string | null;
          currency_code?: string;
          timezone?: string;
          locale?: string;
          is_active?: boolean;
          buffet_enabled?: boolean;
          qr_ordering_enabled?: boolean;
          dine_in_duration_minutes?: number;
          theme_preset_id?: string;
          theme_primary_color?: string;
          theme_primary_strong_color?: string;
          theme_primary_soft_color?: string;
          theme_accent_color?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          name?: string;
          slug?: string;
          address?: string | null;
          phone?: string | null;
          logo_url?: string | null;
          currency_code?: string;
          timezone?: string;
          locale?: string;
          is_active?: boolean;
          buffet_enabled?: boolean;
          qr_ordering_enabled?: boolean;
          dine_in_duration_minutes?: number;
          theme_preset_id?: string;
          theme_primary_color?: string;
          theme_primary_strong_color?: string;
          theme_primary_soft_color?: string;
          theme_accent_color?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      memberships: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string | null;
          user_id: string;
          role: "super_admin" | "owner" | "admin" | "manager" | "cashier" | "staff";
          invited_at: string;
          joined_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id?: string | null;
          user_id: string;
          role: "super_admin" | "owner" | "admin" | "manager" | "cashier" | "staff";
          invited_at?: string;
          joined_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          store_id?: string | null;
          user_id?: string;
          role?: "super_admin" | "owner" | "admin" | "manager" | "cashier" | "staff";
          invited_at?: string;
          joined_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      membership_permission_overrides: {
        Row: {
          id: string;
          membership_id: string;
          organization_id: string;
          store_id: string | null;
          permission_key: string;
          granted: boolean;
          reason: string;
          granted_by_user_id: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          membership_id: string;
          organization_id: string;
          store_id?: string | null;
          permission_key: string;
          granted: boolean;
          reason?: string;
          granted_by_user_id: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          membership_id?: string;
          organization_id?: string;
          store_id?: string | null;
          permission_key?: string;
          granted?: boolean;
          reason?: string;
          granted_by_user_id?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      audit_logs: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string | null;
          actor_user_id: string;
          target_user_id: string | null;
          action: string;
          before: Json | null;
          after: Json | null;
          reason: string | null;
          request_id: string | null;
          ip: string | null;
          user_agent: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id?: string | null;
          actor_user_id: string;
          target_user_id?: string | null;
          action: string;
          before?: Json | null;
          after?: Json | null;
          reason?: string | null;
          request_id?: string | null;
          ip?: string | null;
          user_agent?: string | null;
          created_at?: string;
        };
        Update: never;
        Relationships: [];
      };
      categories: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          name: string;
          description: string | null;
          sort_order: number;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          name: string;
          description?: string | null;
          sort_order?: number;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          store_id?: string;
          name?: string;
          description?: string | null;
          sort_order?: number;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      products: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          category_id: string;
          name: string;
          description: string | null;
          image_url: string | null;
          base_price: number;
          is_active: boolean;
          available_for_pos: boolean;
          available_for_qr: boolean;
          sort_order: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          category_id: string;
          name: string;
          description?: string | null;
          image_url?: string | null;
          base_price?: number;
          is_active?: boolean;
          available_for_pos?: boolean;
          available_for_qr?: boolean;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          store_id?: string;
          category_id?: string;
          name?: string;
          description?: string | null;
          image_url?: string | null;
          base_price?: number;
          is_active?: boolean;
          available_for_pos?: boolean;
          available_for_qr?: boolean;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      product_variants: {
        Row: {
          id: string;
          product_id: string;
          name: string;
          price_adjustment: number;
          sku: string | null;
          stock_quantity: number | null;
          track_stock: boolean;
          is_active: boolean;
          sort_order: number;
        };
        Insert: {
          id?: string;
          product_id: string;
          name: string;
          price_adjustment?: number;
          sku?: string | null;
          stock_quantity?: number | null;
          track_stock?: boolean;
          is_active?: boolean;
          sort_order?: number;
        };
        Update: {
          id?: string;
          product_id?: string;
          name?: string;
          price_adjustment?: number;
          sku?: string | null;
          stock_quantity?: number | null;
          track_stock?: boolean;
          is_active?: boolean;
          sort_order?: number;
        };
        Relationships: [];
      };
      modifier_groups: {
        Row: {
          id: string;
          product_id: string;
          name: string;
          selection_type: "single" | "multiple";
          is_required: boolean;
          min_selections: number;
          max_selections: number;
          sort_order: number;
        };
        Insert: {
          id?: string;
          product_id: string;
          name: string;
          selection_type: "single" | "multiple";
          is_required?: boolean;
          min_selections?: number;
          max_selections?: number;
          sort_order?: number;
        };
        Update: {
          id?: string;
          product_id?: string;
          name?: string;
          selection_type?: "single" | "multiple";
          is_required?: boolean;
          min_selections?: number;
          max_selections?: number;
          sort_order?: number;
        };
        Relationships: [];
      };
      modifier_options: {
        Row: {
          id: string;
          modifier_group_id: string;
          name: string;
          price_adjustment: number;
          is_default: boolean;
          is_active: boolean;
          sort_order: number;
        };
        Insert: {
          id?: string;
          modifier_group_id: string;
          name: string;
          price_adjustment?: number;
          is_default?: boolean;
          is_active?: boolean;
          sort_order?: number;
        };
        Update: {
          id?: string;
          modifier_group_id?: string;
          name?: string;
          price_adjustment?: number;
          is_default?: boolean;
          is_active?: boolean;
          sort_order?: number;
        };
        Relationships: [];
      };
      tables: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          number: string;
          label: string | null;
          seats: number | null;
          is_active: boolean;
          qr_enabled: boolean;
          status: "available" | "occupied" | "reserved" | "cleaning";
          current_session_id: string | null;
          session_started_at: string | null;
          session_expires_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          number: string;
          label?: string | null;
          seats?: number | null;
          is_active?: boolean;
          qr_enabled?: boolean;
          status?: "available" | "occupied" | "reserved" | "cleaning";
          current_session_id?: string | null;
          session_started_at?: string | null;
          session_expires_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          store_id?: string;
          number?: string;
          label?: string | null;
          seats?: number | null;
          is_active?: boolean;
          qr_enabled?: boolean;
          status?: "available" | "occupied" | "reserved" | "cleaning";
          current_session_id?: string | null;
          session_started_at?: string | null;
          session_expires_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      orders: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          order_number: string;
          status: "draft" | "open" | "pending_payment" | "paid" | "refunded" | "voided" | "cancelled";
          table_id: string | null;
          table_number: string | null;
          buffet_session_id: string | null;
          cashier_id: string;
          system_account_id: string | null;
          subtotal: number;
          discount: number;
          discount_note: string | null;
          total: number;
          note: string | null;
          qr_order_source: boolean;
          prep_status: "new" | "preparing" | "served" | "done";
          created_at: string;
          updated_at: string;
          paid_at: string | null;
          voided_at: string | null;
          void_reason: string | null;
          voided_by_user_id: string | null;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          order_number: string;
          status?: "draft" | "open" | "pending_payment" | "paid" | "refunded" | "voided" | "cancelled";
          table_id?: string | null;
          table_number?: string | null;
          buffet_session_id?: string | null;
          cashier_id: string;
          system_account_id?: string | null;
          subtotal?: number;
          discount?: number;
          discount_note?: string | null;
          total?: number;
          note?: string | null;
          qr_order_source?: boolean;
          prep_status?: "new" | "preparing" | "served" | "done";
          created_at?: string;
          updated_at?: string;
          paid_at?: string | null;
          voided_at?: string | null;
          void_reason?: string | null;
          voided_by_user_id?: string | null;
        };
        Update: {
          id?: string;
          organization_id?: string;
          store_id?: string;
          order_number?: string;
          status?: "draft" | "open" | "pending_payment" | "paid" | "refunded" | "voided" | "cancelled";
          table_id?: string | null;
          table_number?: string | null;
          buffet_session_id?: string | null;
          cashier_id?: string;
          system_account_id?: string | null;
          subtotal?: number;
          discount?: number;
          discount_note?: string | null;
          total?: number;
          note?: string | null;
          qr_order_source?: boolean;
          prep_status?: "new" | "preparing" | "served" | "done";
          created_at?: string;
          updated_at?: string;
          paid_at?: string | null;
          voided_at?: string | null;
          void_reason?: string | null;
          voided_by_user_id?: string | null;
        };
        Relationships: [];
      };
      order_items: {
        Row: {
          id: string;
          order_id: string;
          product_id: string;
          product_name: string;
          variant_id: string | null;
          variant_name: string | null;
          modifiers: Json;
          quantity: number;
          unit_price: number;
          total_price: number;
          note: string | null;
        };
        Insert: {
          id?: string;
          order_id: string;
          product_id: string;
          product_name: string;
          variant_id?: string | null;
          variant_name?: string | null;
          modifiers?: Json;
          quantity: number;
          unit_price: number;
          total_price: number;
          note?: string | null;
        };
        Update: {
          id?: string;
          order_id?: string;
          product_id?: string;
          product_name?: string;
          variant_id?: string | null;
          variant_name?: string | null;
          modifiers?: Json;
          quantity?: number;
          unit_price?: number;
          total_price?: number;
          note?: string | null;
        };
        Relationships: [];
      };
      payments: {
        Row: {
          id: string;
          order_id: string;
          method: "cash" | "qr_promptpay" | "credit_card" | "bank_transfer" | "other";
          amount: number;
          status: "pending" | "completed" | "failed" | "refunded";
          reference: string | null;
          received_amount: number | null;
          change_amount: number | null;
          processed_at: string;
          processed_by_user_id: string;
        };
        Insert: {
          id?: string;
          order_id: string;
          method: "cash" | "qr_promptpay" | "credit_card" | "bank_transfer" | "other";
          amount: number;
          status?: "pending" | "completed" | "failed" | "refunded";
          reference?: string | null;
          received_amount?: number | null;
          change_amount?: number | null;
          processed_at?: string;
          processed_by_user_id: string;
        };
        Update: {
          id?: string;
          order_id?: string;
          method?: "cash" | "qr_promptpay" | "credit_card" | "bank_transfer" | "other";
          amount?: number;
          status?: "pending" | "completed" | "failed" | "refunded";
          reference?: string | null;
          received_amount?: number | null;
          change_amount?: number | null;
          processed_at?: string;
          processed_by_user_id?: string;
        };
        Relationships: [];
      };
      accounting_categories: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          name: string;
          type: "income" | "expense" | "cash_adjustment";
          is_default: boolean;
          sort_order: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          name: string;
          type: "income" | "expense" | "cash_adjustment";
          is_default?: boolean;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          store_id?: string;
          name?: string;
          type?: "income" | "expense" | "cash_adjustment";
          is_default?: boolean;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      transactions: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          type: "income" | "expense" | "cash_adjustment";
          category_id: string;
          category_name: string;
          amount: number;
          note: string | null;
          date: string;
          created_by_user_id: string;
          order_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          type: "income" | "expense" | "cash_adjustment";
          category_id: string;
          category_name: string;
          amount: number;
          note?: string | null;
          date: string;
          created_by_user_id: string;
          order_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          store_id?: string;
          type?: "income" | "expense" | "cash_adjustment";
          category_id?: string;
          category_name?: string;
          amount?: number;
          note?: string | null;
          date?: string;
          created_by_user_id?: string;
          order_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      cash_ledger_entries: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          type: "open" | "close" | "adjustment" | "pos_sale" | "expense" | "income";
          amount: number;
          balance_after: number;
          transaction_id: string | null;
          order_id: string | null;
          note: string | null;
          created_by_user_id: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          type: "open" | "close" | "adjustment" | "pos_sale" | "expense" | "income";
          amount: number;
          balance_after: number;
          transaction_id?: string | null;
          order_id?: string | null;
          note?: string | null;
          created_by_user_id: string;
          created_at?: string;
        };
        Update: never;
        Relationships: [];
      };
      cash_sessions: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          status: "open" | "closed";
          opening_float: number;
          opened_by_user_id: string;
          opened_at: string;
          open_note: string | null;
          closing_count: number | null;
          cash_sales: number | null;
          expected_cash: number | null;
          variance: number | null;
          closed_by_user_id: string | null;
          closed_at: string | null;
          close_note: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          status?: "open" | "closed";
          opening_float?: number;
          opened_by_user_id: string;
          opened_at?: string;
          open_note?: string | null;
          closing_count?: number | null;
          cash_sales?: number | null;
          expected_cash?: number | null;
          variance?: number | null;
          closed_by_user_id?: string | null;
          closed_at?: string | null;
          close_note?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: never;
        Relationships: [];
      };
      service_requests: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          table_id: string;
          table_number: string;
          type: "call_staff" | "request_bill";
          status: "pending" | "resolved";
          note: string | null;
          created_at: string;
          resolved_at: string | null;
          resolved_by_user_id: string | null;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          table_id: string;
          table_number: string;
          type: "call_staff" | "request_bill";
          status?: "pending" | "resolved";
          note?: string | null;
          created_at?: string;
          resolved_at?: string | null;
          resolved_by_user_id?: string | null;
        };
        Update: {
          status?: "pending" | "resolved";
          note?: string | null;
          resolved_at?: string | null;
          resolved_by_user_id?: string | null;
        };
        Relationships: [];
      };
      employee_profiles: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          user_id: string;
          display_name: string | null;
          pay_type: "monthly" | "daily" | "hourly";
          monthly_salary: number;
          daily_rate: number;
          hourly_rate: number;
          expected_start_time: string | null;
          late_grace_minutes: number;
          late_penalty_amount: number;
          absent_penalty_amount: number;
          working_days: number[];
          ot_eligible: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          user_id: string;
          display_name?: string | null;
          pay_type?: "monthly" | "daily" | "hourly";
          monthly_salary?: number;
          daily_rate?: number;
          hourly_rate?: number;
          expected_start_time?: string | null;
          late_grace_minutes?: number;
          late_penalty_amount?: number;
          absent_penalty_amount?: number;
          working_days?: number[];
          ot_eligible?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          display_name?: string | null;
          pay_type?: "monthly" | "daily" | "hourly";
          monthly_salary?: number;
          daily_rate?: number;
          hourly_rate?: number;
          expected_start_time?: string | null;
          late_grace_minutes?: number;
          late_penalty_amount?: number;
          absent_penalty_amount?: number;
          working_days?: number[];
          ot_eligible?: boolean;
          updated_at?: string;
        };
        Relationships: [];
      };
      store_hr_settings: {
        Row: {
          store_id: string;
          organization_id: string;
          regular_hours_per_day: number;
          ot_multiplier: number;
          ot_daily_cap_hours: number;
          late_penalty_per_minute: number;
          late_penalty_max_per_day: number;
          absent_penalty_per_day: number;
          backdated_rights_per_month: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          store_id: string;
          organization_id: string;
          regular_hours_per_day?: number;
          ot_multiplier?: number;
          ot_daily_cap_hours?: number;
          late_penalty_per_minute?: number;
          late_penalty_max_per_day?: number;
          absent_penalty_per_day?: number;
          backdated_rights_per_month?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          regular_hours_per_day?: number;
          ot_multiplier?: number;
          ot_daily_cap_hours?: number;
          late_penalty_per_minute?: number;
          late_penalty_max_per_day?: number;
          absent_penalty_per_day?: number;
          backdated_rights_per_month?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      store_holidays: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          date: string;
          name: string | null;
          created_by_user_id: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          date: string;
          name?: string | null;
          created_by_user_id: string;
          created_at?: string;
        };
        Update: {
          name?: string | null;
        };
        Relationships: [];
      };
      payroll_adjustments: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          user_id: string;
          employee_name: string;
          date: string;
          type: "penalty" | "bonus" | "leave" | "absent" | "late";
          amount: number;
          note: string | null;
          created_by_user_id: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          user_id: string;
          employee_name: string;
          date: string;
          type: "penalty" | "bonus" | "leave" | "absent" | "late";
          amount: number;
          note?: string | null;
          created_by_user_id: string;
          created_at?: string;
        };
        Update: never;
        Relationships: [];
      };
      attendance_records: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          user_id: string;
          employee_name: string;
          date: string;
          clock_in_at: string;
          clock_out_at: string | null;
          clock_in_lat: number | null;
          clock_in_lng: number | null;
          clock_in_location_label: string | null;
          clock_out_lat: number | null;
          clock_out_lng: number | null;
          clock_out_location_label: string | null;
          status: "active" | "completed" | "backdated" | "adjusted";
          note: string | null;
          adjusted_by_user_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          user_id: string;
          employee_name: string;
          date: string;
          clock_in_at: string;
          clock_out_at?: string | null;
          clock_in_lat?: number | null;
          clock_in_lng?: number | null;
          clock_in_location_label?: string | null;
          clock_out_lat?: number | null;
          clock_out_lng?: number | null;
          clock_out_location_label?: string | null;
          status?: "active" | "completed" | "backdated" | "adjusted";
          note?: string | null;
          adjusted_by_user_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          store_id?: string;
          user_id?: string;
          employee_name?: string;
          date?: string;
          clock_in_at?: string;
          clock_out_at?: string | null;
          clock_in_lat?: number | null;
          clock_in_lng?: number | null;
          clock_in_location_label?: string | null;
          clock_out_lat?: number | null;
          clock_out_lng?: number | null;
          clock_out_location_label?: string | null;
          status?: "active" | "completed" | "backdated" | "adjusted";
          note?: string | null;
          adjusted_by_user_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      attendance_settings: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          geofence_enabled: boolean;
          geofence_center_lat: number | null;
          geofence_center_lng: number | null;
          geofence_radius_meters: number | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          geofence_enabled?: boolean;
          geofence_center_lat?: number | null;
          geofence_center_lng?: number | null;
          geofence_radius_meters?: number | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          store_id?: string;
          geofence_enabled?: boolean;
          geofence_center_lat?: number | null;
          geofence_center_lng?: number | null;
          geofence_radius_meters?: number | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      buffet_sessions: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          table_id: string | null;
          package_name: string;
          price_per_guest: number;
          guest_count: number;
          started_at: string;
          ended_at: string | null;
          status: "open" | "closed";
          order_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          table_id?: string | null;
          package_name: string;
          price_per_guest: number;
          guest_count: number;
          started_at?: string;
          ended_at?: string | null;
          status?: "open" | "closed";
          order_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          store_id?: string;
          table_id?: string | null;
          package_name?: string;
          price_per_guest?: number;
          guest_count?: number;
          started_at?: string;
          ended_at?: string | null;
          status?: "open" | "closed";
          order_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      receipt_settings: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          store_name: string;
          address: string | null;
          phone: string | null;
          tax_id: string | null;
          show_tax_id: boolean;
          show_qr_payment: boolean;
          promptpay_id: string | null;
          header_text: string | null;
          footer_text: string | null;
          logo_url: string | null;
          paper_width: "58mm" | "80mm";
          print_copies: number;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          store_name: string;
          address?: string | null;
          phone?: string | null;
          tax_id?: string | null;
          show_tax_id?: boolean;
          show_qr_payment?: boolean;
          promptpay_id?: string | null;
          header_text?: string | null;
          footer_text?: string | null;
          logo_url?: string | null;
          paper_width?: "58mm" | "80mm";
          print_copies?: number;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          store_id?: string;
          store_name?: string;
          address?: string | null;
          phone?: string | null;
          tax_id?: string | null;
          show_tax_id?: boolean;
          show_qr_payment?: boolean;
          promptpay_id?: string | null;
          header_text?: string | null;
          footer_text?: string | null;
          logo_url?: string | null;
          paper_width?: "58mm" | "80mm";
          print_copies?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      notification_targets: {
        Row: {
          id: string;
          organization_id: string;
          channel: "telegram";
          telegram_chat_id: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          channel?: "telegram";
          telegram_chat_id: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          channel?: "telegram";
          telegram_chat_id?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      notification_settings: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          notification_type: "payment" | "new_table" | "new_pos_order" | "new_qr_order" | "new_buffet_order" | "kitchen_order" | "buffet_expiring" | "stock_alert" | "order_cancelled" | "approval" | "service_request" | "test";
          channel: "line" | "telegram";
          enabled: boolean;
          destination: "owner" | "group" | "all";
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          notification_type: "payment" | "new_table" | "new_pos_order" | "new_qr_order" | "new_buffet_order" | "kitchen_order" | "buffet_expiring" | "stock_alert" | "order_cancelled" | "approval" | "service_request" | "test";
          channel: "line" | "telegram";
          enabled?: boolean;
          destination?: "owner" | "group" | "all";
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          store_id?: string;
          notification_type?: "payment" | "new_table" | "new_pos_order" | "new_qr_order" | "new_buffet_order" | "kitchen_order" | "buffet_expiring" | "stock_alert" | "order_cancelled" | "approval" | "service_request" | "test";
          channel?: "line" | "telegram";
          enabled?: boolean;
          destination?: "owner" | "group" | "all";
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      printers: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          name: string;
          type: "browser" | "usb" | "bluetooth" | "ip" | "escpos";
          is_default: boolean;
          ip_address: string | null;
          port: number | null;
          usb_vendor_id: string | null;
          usb_product_id: string | null;
          bluetooth_device_id: string | null;
          paper_width: "58mm" | "80mm";
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          name: string;
          type: "browser" | "usb" | "bluetooth" | "ip" | "escpos";
          is_default?: boolean;
          ip_address?: string | null;
          port?: number | null;
          usb_vendor_id?: string | null;
          usb_product_id?: string | null;
          bluetooth_device_id?: string | null;
          paper_width?: "58mm" | "80mm";
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          store_id?: string;
          name?: string;
          type?: "browser" | "usb" | "bluetooth" | "ip" | "escpos";
          is_default?: boolean;
          ip_address?: string | null;
          port?: number | null;
          usb_vendor_id?: string | null;
          usb_product_id?: string | null;
          bluetooth_device_id?: string | null;
          paper_width?: "58mm" | "80mm";
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      auth_user_organization_ids: { Args: Record<string, never>; Returns: string[] };
      auth_user_store_ids: { Args: Record<string, never>; Returns: string[] };
      auth_user_role_in_org: { Args: { org_id: string; min_role: string }; Returns: boolean };
      auth_user_role_in_store: { Args: { org_id: string; target_store_id: string; min_role: string }; Returns: boolean };
      begin_billing_event_processing: {
        Args: {
          p_stripe_event_id: string;
          p_event_type: string;
          p_processing_attempt_id: string;
          p_stale_after?: string;
        };
        Returns: string;
      };
      close_pos_order_payment: {
        Args: {
          p_order_id: string;
          p_store_id: string;
          p_processed_by_user_id: string;
          p_method: string;
          p_amount: number;
          p_received_amount?: number | null;
          p_change_amount?: number | null;
          p_reference?: string | null;
        };
        Returns: string;
      };
      open_cash_session: {
        Args: {
          p_store_id: string;
          p_opening_float: number;
          p_note?: string | null;
        };
        Returns: string;
      };
      close_cash_session: {
        Args: {
          p_session_id: string;
          p_store_id: string;
          p_closing_count: number;
          p_note?: string | null;
        };
        Returns: Database["public"]["Tables"]["cash_sessions"]["Row"];
      };
      create_buffet_session_with_table: {
        Args: {
          p_organization_id: string;
          p_store_id: string;
          p_table_id?: string | null;
          p_package_name: string;
          p_price_per_guest: number;
          p_guest_count: number;
        };
        Returns: Database["public"]["Tables"]["buffet_sessions"]["Row"];
      };
      close_buffet_session_with_table: {
        Args: {
          p_session_id: string;
          p_store_id: string;
        };
        Returns: Database["public"]["Tables"]["buffet_sessions"]["Row"];
      };
      create_pos_order_with_items: {
        Args: {
          p_organization_id: string;
          p_store_id: string;
          p_order_number: string;
          p_table_id?: string | null;
          p_table_number?: string | null;
          p_cashier_id?: string | null;
          p_subtotal?: number;
          p_discount?: number;
          p_discount_note?: string | null;
          p_total?: number;
          p_note?: string | null;
          p_items?: Json;
        };
        Returns: string;
      };
      create_qr_order_with_items: {
        Args: {
          p_organization_id: string;
          p_store_id: string;
          p_table_id: string;
          p_order_number: string;
          p_subtotal: number;
          p_items?: Json;
        };
        Returns: string;
      };
      create_service_request: {
        Args: {
          p_store_id: string;
          p_table_id: string;
          p_type: string;
          p_note?: string | null;
        };
        Returns: string;
      };
      open_table_session: {
        Args: { p_store_id: string; p_table_id: string; p_minutes: number };
        Returns: string;
      };
      close_table_session: {
        Args: { p_store_id: string; p_table_id: string };
        Returns: undefined;
      };
      claim_premium_free_trial: {
        Args: {
          p_organization_id: string;
          p_user_id: string;
        };
        Returns: {
          ok: boolean;
          code: string;
          new_expiry: string | null;
        }[];
      };
      get_report_sales_summary: {
        Args: {
          p_store_id: string;
          p_date_from: string;
          p_date_to: string;
        };
        Returns: {
          order_count: number;
          revenue: number;
          avg_order_value: number;
          qr_order_count: number;
          pos_order_count: number;
        }[];
      };
      get_report_daily_sales: {
        Args: {
          p_store_id: string;
          p_date_from: string;
          p_date_to: string;
        };
        Returns: {
          date: string;
          order_count: number;
          revenue: number;
        }[];
      };
    };
    Enums: Record<string, never>;
  };
}
