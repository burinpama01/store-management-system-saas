export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface Database {
  public: {
    Tables: {
      api_keys: {
        Row: {
          id: string;
          organization_id: string;
          name: string;
          key_prefix: string;
          key_hash: string;
          scopes: string[];
          last_used_at: string | null;
          created_by: string | null;
          created_at: string;
          revoked_at: string | null;
        };
        Insert: {
          id?: string;
          organization_id: string;
          name: string;
          key_prefix: string;
          key_hash: string;
          scopes?: string[];
          last_used_at?: string | null;
          created_by?: string | null;
          created_at?: string;
          revoked_at?: string | null;
        };
        Update: {
          id?: string;
          organization_id?: string;
          name?: string;
          key_prefix?: string;
          key_hash?: string;
          scopes?: string[];
          last_used_at?: string | null;
          created_by?: string | null;
          created_at?: string;
          revoked_at?: string | null;
        };
        Relationships: [];
      };
      connect_channel_links: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          channel: string;
          external_merchant_id: string;
          status: "active" | "paused" | "disconnected";
          webhook_secret: string;
          jdc_functions_base_url: string | null;
          auto_accept: boolean;
          commission_rate: number;
          config: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          channel?: string;
          external_merchant_id: string;
          status?: "active" | "paused" | "disconnected";
          webhook_secret: string;
          jdc_functions_base_url?: string | null;
          auto_accept?: boolean;
          commission_rate?: number;
          config?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          store_id?: string;
          channel?: string;
          external_merchant_id?: string;
          status?: "active" | "paused" | "disconnected";
          webhook_secret?: string;
          jdc_functions_base_url?: string | null;
          auto_accept?: boolean;
          commission_rate?: number;
          config?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      connect_menu_map: {
        Row: {
          id: string;
          link_id: string;
          product_id: string;
          external_item_id: string | null;
          sync_hash: string | null;
          last_synced_at: string | null;
          last_error: string | null;
        };
        Insert: {
          id?: string;
          link_id: string;
          product_id: string;
          external_item_id?: string | null;
          sync_hash?: string | null;
          last_synced_at?: string | null;
          last_error?: string | null;
        };
        Update: {
          id?: string;
          link_id?: string;
          product_id?: string;
          external_item_id?: string | null;
          sync_hash?: string | null;
          last_synced_at?: string | null;
          last_error?: string | null;
        };
        Relationships: [];
      };
      connect_orders: {
        Row: {
          id: string;
          organization_id: string;
          link_id: string;
          external_order_id: string;
          internal_order_id: string | null;
          channel: string;
          fulfillment_status:
            | "received"
            | "accepted"
            | "preparing"
            | "ready"
            | "completed"
            | "cancelled";
          last_status_origin: string | null;
          raw_payload: Json;
          received_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          link_id: string;
          external_order_id: string;
          internal_order_id?: string | null;
          channel?: string;
          fulfillment_status?:
            | "received"
            | "accepted"
            | "preparing"
            | "ready"
            | "completed"
            | "cancelled";
          last_status_origin?: string | null;
          raw_payload: Json;
          received_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          link_id?: string;
          external_order_id?: string;
          internal_order_id?: string | null;
          channel?: string;
          fulfillment_status?:
            | "received"
            | "accepted"
            | "preparing"
            | "ready"
            | "completed"
            | "cancelled";
          last_status_origin?: string | null;
          raw_payload?: Json;
          received_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      connect_events: {
        Row: {
          id: string;
          link_id: string;
          direction: "outbound" | "inbound";
          topic: string;
          payload: Json;
          status: "pending" | "sent" | "failed" | "dead";
          attempts: number;
          next_retry_at: string | null;
          last_error: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          link_id: string;
          direction: "outbound" | "inbound";
          topic: string;
          payload: Json;
          status?: "pending" | "sent" | "failed" | "dead";
          attempts?: number;
          next_retry_at?: string | null;
          last_error?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          link_id?: string;
          direction?: "outbound" | "inbound";
          topic?: string;
          payload?: Json;
          status?: "pending" | "sent" | "failed" | "dead";
          attempts?: number;
          next_retry_at?: string | null;
          last_error?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      platform_settings: {
        Row: {
          id: string;
          billing_provider: "promptpay" | "stripe";
          promptpay_id: string | null;
          promptpay_name: string | null;
          promptpay_static_payload: string | null;
          enterprise_from_email: string | null;
          logo_url: string | null;
          jdc_functions_base_url: string | null;
          jdc_api_key: string | null;
          jdc_webhook_secret: string | null;
          free_trial_enabled: boolean;
          free_trial_starts_at: string | null;
          free_trial_ends_at: string | null;
          updated_by: string | null;
          updated_at: string;
        };
        Insert: {
          id?: string;
          billing_provider?: "promptpay" | "stripe";
          promptpay_id?: string | null;
          promptpay_name?: string | null;
          promptpay_static_payload?: string | null;
          enterprise_from_email?: string | null;
          logo_url?: string | null;
          jdc_functions_base_url?: string | null;
          jdc_api_key?: string | null;
          jdc_webhook_secret?: string | null;
          free_trial_enabled?: boolean;
          free_trial_starts_at?: string | null;
          free_trial_ends_at?: string | null;
          updated_by?: string | null;
          updated_at?: string;
        };
        Update: {
          id?: string;
          billing_provider?: "promptpay" | "stripe";
          promptpay_id?: string | null;
          promptpay_name?: string | null;
          promptpay_static_payload?: string | null;
          enterprise_from_email?: string | null;
          logo_url?: string | null;
          jdc_functions_base_url?: string | null;
          jdc_api_key?: string | null;
          jdc_webhook_secret?: string | null;
          free_trial_enabled?: boolean;
          free_trial_starts_at?: string | null;
          free_trial_ends_at?: string | null;
          updated_by?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      enterprise_requests: {
        Row: {
          id: string;
          company_name: string;
          contact_name: string;
          email: string;
          phone: string | null;
          branch_count: number | null;
          message: string | null;
          organization_id: string | null;
          status: "new" | "contacted" | "closed";
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          company_name: string;
          contact_name: string;
          email: string;
          phone?: string | null;
          branch_count?: number | null;
          message?: string | null;
          organization_id?: string | null;
          status?: "new" | "contacted" | "closed";
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          company_name?: string;
          contact_name?: string;
          email?: string;
          phone?: string | null;
          branch_count?: number | null;
          message?: string | null;
          organization_id?: string | null;
          status?: "new" | "contacted" | "closed";
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      payment_submissions: {
        Row: {
          id: string;
          organization_id: string;
          plan: "starter" | "standard" | "premium" | "business";
          duration: "30d" | "1y";
          amount_expected: number;
          verified_amount: number | null;
          slip_ref: string | null;
          slip_image_path: string | null;
          slip2go_raw: Json | null;
          status: "pending" | "verified" | "rejected" | "duplicate";
          reason: string | null;
          submitted_by: string | null;
          discount_code_id: string | null;
          discount_amount: number;
          business_seats: number | null;
          business_stores: number | null;
          business_features: Json;
          created_at: string;
          verified_at: string | null;
        };
        Insert: {
          id?: string;
          organization_id: string;
          plan: "starter" | "standard" | "premium" | "business";
          duration: "30d" | "1y";
          amount_expected: number;
          verified_amount?: number | null;
          slip_ref?: string | null;
          slip_image_path?: string | null;
          slip2go_raw?: Json | null;
          status?: "pending" | "verified" | "rejected" | "duplicate";
          reason?: string | null;
          submitted_by?: string | null;
          discount_code_id?: string | null;
          discount_amount?: number;
          business_seats?: number | null;
          business_stores?: number | null;
          business_features?: Json;
          created_at?: string;
          verified_at?: string | null;
        };
        Update: {
          id?: string;
          organization_id?: string;
          plan?: "starter" | "standard" | "premium" | "business";
          duration?: "30d" | "1y";
          amount_expected?: number;
          verified_amount?: number | null;
          slip_ref?: string | null;
          slip_image_path?: string | null;
          slip2go_raw?: Json | null;
          status?: "pending" | "verified" | "rejected" | "duplicate";
          reason?: string | null;
          submitted_by?: string | null;
          discount_code_id?: string | null;
          discount_amount?: number;
          business_seats?: number | null;
          business_stores?: number | null;
          business_features?: Json;
          created_at?: string;
          verified_at?: string | null;
        };
        Relationships: [];
      };
      billing_discount_codes: {
        Row: {
          id: string;
          code: string;
          normalized_code: string;
          description: string;
          discount_type: "percentage" | "fixed";
          discount_value: number;
          plan: "starter" | "standard" | "premium" | "business" | null;
          duration: "30d" | "1y" | null;
          min_amount: number;
          max_redemptions: number | null;
          max_redemptions_per_org: number | null;
          active: boolean;
          starts_at: string | null;
          ends_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          code: string;
          normalized_code: string;
          description: string;
          discount_type: "percentage" | "fixed";
          discount_value: number;
          plan?: "starter" | "standard" | "premium" | "business" | null;
          duration?: "30d" | "1y" | null;
          min_amount?: number;
          max_redemptions?: number | null;
          max_redemptions_per_org?: number | null;
          active?: boolean;
          starts_at?: string | null;
          ends_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          code?: string;
          normalized_code?: string;
          description?: string;
          discount_type?: "percentage" | "fixed";
          discount_value?: number;
          plan?: "starter" | "standard" | "premium" | "business" | null;
          duration?: "30d" | "1y" | null;
          min_amount?: number;
          max_redemptions?: number | null;
          max_redemptions_per_org?: number | null;
          active?: boolean;
          starts_at?: string | null;
          ends_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      billing_premium_trial_redemptions: {
        Row: {
          id: string;
          organization_id: string;
          user_id: string;
          promotion_code: string;
          plan: "premium" | "enterprise";
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
          plan: "premium" | "enterprise";
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
          plan?: "premium" | "enterprise";
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
      business_plan_prices: {
        Row: {
          component: string;
          duration: "30d" | "1y";
          amount: number;
          updated_at: string;
        };
        Insert: {
          component: string;
          duration: "30d" | "1y";
          amount: number;
          updated_at?: string;
        };
        Update: {
          component?: string;
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
          plan: "starter" | "standard" | "premium" | "business" | null;
          starts_at: string | null;
          ends_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          description: string;
          percent_off: number;
          active?: boolean;
          plan?: "starter" | "standard" | "premium" | "business" | null;
          starts_at?: string | null;
          ends_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          description?: string;
          percent_off?: number;
          active?: boolean;
          plan?: "starter" | "standard" | "premium" | "business" | null;
          starts_at?: string | null;
          ends_at?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      plan_settings: {
        Row: {
          tier: "starter" | "standard" | "premium" | "business" | "enterprise";
          display_name: string;
          visible_on_landing: boolean;
          highlight: boolean;
          feature_lines: Json;
          sort_order: number;
          updated_at: string;
        };
        Insert: {
          tier: "starter" | "standard" | "premium" | "business" | "enterprise";
          display_name: string;
          visible_on_landing?: boolean;
          highlight?: boolean;
          feature_lines?: Json;
          sort_order?: number;
          updated_at?: string;
        };
        Update: {
          tier?: "starter" | "standard" | "premium" | "business" | "enterprise";
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
          plan: "free" | "starter" | "standard" | "premium" | "business" | "enterprise";
          status: "active" | "trialing" | "past_due" | "incomplete" | "incomplete_expired" | "unpaid" | "canceled" | "paused";
          stripe_subscription_id: string | null;
          stripe_price_id: string | null;
          current_period_start: string;
          current_period_end: string;
          cancel_at_period_end: boolean;
          trial_end: string | null;
          promo_trial_code: string | null;
          enterprise_limited: boolean;
          business_seats: number | null;
          business_stores: number | null;
          business_features: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          plan?: "free" | "starter" | "standard" | "premium" | "business" | "enterprise";
          status?: "active" | "trialing" | "past_due" | "incomplete" | "incomplete_expired" | "unpaid" | "canceled" | "paused";
          stripe_subscription_id?: string | null;
          stripe_price_id?: string | null;
          current_period_start?: string;
          current_period_end?: string;
          cancel_at_period_end?: boolean;
          trial_end?: string | null;
          promo_trial_code?: string | null;
          enterprise_limited?: boolean;
          business_seats?: number | null;
          business_stores?: number | null;
          business_features?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          plan?: "free" | "starter" | "standard" | "premium" | "business" | "enterprise";
          status?: "active" | "trialing" | "past_due" | "incomplete" | "incomplete_expired" | "unpaid" | "canceled" | "paused";
          stripe_subscription_id?: string | null;
          stripe_price_id?: string | null;
          current_period_start?: string;
          current_period_end?: string;
          cancel_at_period_end?: boolean;
          trial_end?: string | null;
          promo_trial_code?: string | null;
          enterprise_limited?: boolean;
          business_seats?: number | null;
          business_stores?: number | null;
          business_features?: Json;
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
          qr_ordering_mode: "table_bound" | "session_printed";
          table_open_policy: "staff_only" | "customer_self";
          music_request_enabled: boolean;
          music_license_status: "not_requested" | "pending" | "approved" | "rejected" | "expired";
          music_license_approved_at: string | null;
          music_license_note: string | null;
          qr_service_buttons: Json;
          dine_in_no_expiry: boolean;
          setup_profile: Json;
          print_hub_token_hash: string | null;
          print_hub_last_seen: string | null;
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
          qr_ordering_mode?: "table_bound" | "session_printed";
          table_open_policy?: "staff_only" | "customer_self";
          music_request_enabled?: boolean;
          music_license_status?: "not_requested" | "pending" | "approved" | "rejected" | "expired";
          music_license_approved_at?: string | null;
          music_license_note?: string | null;
          qr_service_buttons?: Json;
          dine_in_no_expiry?: boolean;
          setup_profile?: Json;
          print_hub_token_hash?: string | null;
          print_hub_last_seen?: string | null;
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
          qr_ordering_mode?: "table_bound" | "session_printed";
          table_open_policy?: "staff_only" | "customer_self";
          music_request_enabled?: boolean;
          music_license_status?: "not_requested" | "pending" | "approved" | "rejected" | "expired";
          music_license_approved_at?: string | null;
          music_license_note?: string | null;
          qr_service_buttons?: Json;
          dine_in_no_expiry?: boolean;
          setup_profile?: Json;
          print_hub_token_hash?: string | null;
          print_hub_last_seen?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      print_jobs: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          printer_id: string | null;
          target_kind: "ip" | "bt";
          target_host: string | null;
          target_device: string | null;
          target_port: number;
          payload_b64: string;
          status: "pending" | "claimed" | "printed" | "failed";
          attempts: number;
          error: string | null;
          claimed_at: string | null;
          printed_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          printer_id?: string | null;
          target_kind?: "ip" | "bt";
          target_host?: string | null;
          target_device?: string | null;
          target_port?: number;
          payload_b64: string;
          status?: "pending" | "claimed" | "printed" | "failed";
          attempts?: number;
          error?: string | null;
          claimed_at?: string | null;
          printed_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          store_id?: string;
          printer_id?: string | null;
          target_kind?: "ip" | "bt";
          target_host?: string | null;
          target_device?: string | null;
          target_port?: number;
          payload_b64?: string;
          status?: "pending" | "claimed" | "printed" | "failed";
          attempts?: number;
          error?: string | null;
          claimed_at?: string | null;
          printed_at?: string | null;
          created_at?: string;
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
      catalog_barcodes: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          normalized_barcode: string;
          product_id: string | null;
          variant_id: string | null;
          source: "product" | "variant";
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          normalized_barcode: string;
          product_id?: string | null;
          variant_id?: string | null;
          source: "product" | "variant";
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          store_id?: string;
          normalized_barcode?: string;
          product_id?: string | null;
          variant_id?: string | null;
          source?: "product" | "variant";
          created_at?: string;
        };
        Relationships: [];
      };
      products: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          category_id: string;
          menu_link_id: string | null;
          kitchen_station_id: string | null;
          name: string;
          description: string | null;
          barcode: string | null;
          image_url: string | null;
          base_price: number;
          is_active: boolean;
          available_for_pos: boolean;
          available_for_qr: boolean;
          available_for_delivery: boolean;
          delivery_price: number | null;
          delivery_out_of_stock: boolean;
          out_of_stock: boolean;
          unit_label: string | null;
          price_wholesale: number | null;
          price_agent: number | null;
          price_regular: number | null;
          sort_order: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          category_id: string;
          menu_link_id?: string | null;
          kitchen_station_id?: string | null;
          name: string;
          description?: string | null;
          barcode?: string | null;
          image_url?: string | null;
          base_price?: number;
          is_active?: boolean;
          available_for_pos?: boolean;
          available_for_qr?: boolean;
          available_for_delivery?: boolean;
          delivery_price?: number | null;
          delivery_out_of_stock?: boolean;
          out_of_stock?: boolean;
          unit_label?: string | null;
          price_wholesale?: number | null;
          price_agent?: number | null;
          price_regular?: number | null;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          store_id?: string;
          category_id?: string;
          menu_link_id?: string | null;
          kitchen_station_id?: string | null;
          name?: string;
          description?: string | null;
          barcode?: string | null;
          image_url?: string | null;
          base_price?: number;
          is_active?: boolean;
          available_for_pos?: boolean;
          available_for_qr?: boolean;
          available_for_delivery?: boolean;
          delivery_price?: number | null;
          delivery_out_of_stock?: boolean;
          out_of_stock?: boolean;
          unit_label?: string | null;
          price_wholesale?: number | null;
          price_agent?: number | null;
          price_regular?: number | null;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      kitchen_stations: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          name: string;
          description: string | null;
          sort_order: number;
          is_active: boolean;
          printer_id: string | null;
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
          printer_id?: string | null;
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
          printer_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      kitchen_station_staff: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          kitchen_station_id: string;
          user_id: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          kitchen_station_id: string;
          user_id: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          store_id?: string;
          kitchen_station_id?: string;
          user_id?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      catalog_modifier_group_templates: {
        Row: {
          id: string;
          store_id: string;
          name: string;
          selection_type: "single" | "multiple";
          is_required: boolean;
          min_selections: number;
          max_selections: number;
          sort_order: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          store_id: string;
          name: string;
          selection_type?: "single" | "multiple";
          is_required?: boolean;
          min_selections?: number;
          max_selections?: number;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          store_id?: string;
          name?: string;
          selection_type?: "single" | "multiple";
          is_required?: boolean;
          min_selections?: number;
          max_selections?: number;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      catalog_modifier_option_templates: {
        Row: {
          id: string;
          group_template_id: string;
          name: string;
          price_adjustment: number;
          is_default: boolean;
          sort_order: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          group_template_id: string;
          name: string;
          price_adjustment?: number;
          is_default?: boolean;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          group_template_id?: string;
          name?: string;
          price_adjustment?: number;
          is_default?: boolean;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      catalog_variant_templates: {
        Row: {
          id: string;
          store_id: string;
          name: string;
          price_adjustment: number;
          sort_order: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          store_id: string;
          name: string;
          price_adjustment?: number;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          store_id?: string;
          name?: string;
          price_adjustment?: number;
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
          store_id: string;
          name: string;
          barcode: string | null;
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
          store_id?: string;
          name: string;
          barcode?: string | null;
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
          store_id?: string;
          name?: string;
          barcode?: string | null;
          price_adjustment?: number;
          sku?: string | null;
          stock_quantity?: number | null;
          track_stock?: boolean;
          is_active?: boolean;
          sort_order?: number;
        };
        Relationships: [];
      };
      product_units: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          product_id: string;
          name: string;
          quantity: number;
          price: number;
          price_wholesale: number | null;
          price_agent: number | null;
          price_regular: number | null;
          barcode: string | null;
          sort_order: number;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id?: string;
          store_id?: string;
          product_id: string;
          name: string;
          quantity: number;
          price: number;
          price_wholesale?: number | null;
          price_agent?: number | null;
          price_regular?: number | null;
          barcode?: string | null;
          sort_order?: number;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          store_id?: string;
          product_id?: string;
          name?: string;
          quantity?: number;
          price?: number;
          price_wholesale?: number | null;
          price_agent?: number | null;
          price_regular?: number | null;
          barcode?: string | null;
          sort_order?: number;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
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
          buffet_expiry_notified_at: string | null;
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
          buffet_expiry_notified_at?: string | null;
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
          buffet_expiry_notified_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      pos_saved_tickets: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          ticket_number: string;
          label: string;
          cart_snapshot: Json;
          table_id: string | null;
          table_number: string | null;
          customer_name: string | null;
          note: string | null;
          buffet_session_id: string | null;
          created_by_user_id: string;
          updated_by_user_id: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          ticket_number: string;
          label: string;
          cart_snapshot: Json;
          table_id?: string | null;
          table_number?: string | null;
          customer_name?: string | null;
          note?: string | null;
          buffet_session_id?: string | null;
          created_by_user_id: string;
          updated_by_user_id: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          store_id?: string;
          ticket_number?: string;
          label?: string;
          cart_snapshot?: Json;
          table_id?: string | null;
          table_number?: string | null;
          customer_name?: string | null;
          note?: string | null;
          buffet_session_id?: string | null;
          created_by_user_id?: string;
          updated_by_user_id?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      pos_devices: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          device_key: string;
          label: string | null;
          last_seen_at: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          device_key: string;
          label?: string | null;
          last_seen_at?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          store_id?: string;
          device_key?: string;
          label?: string | null;
          last_seen_at?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      pos_sync_operations: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          device_id: string;
          operation_type: "create_order";
          status: "pending" | "processing" | "succeeded" | "failed" | "conflict";
          idempotency_key: string;
          catalog_version: string;
          payload: Json;
          result_order_id: string | null;
          error_message: string | null;
          attempt_count: number;
          last_attempt_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          device_id: string;
          operation_type: "create_order";
          status?: "pending" | "processing" | "succeeded" | "failed" | "conflict";
          idempotency_key: string;
          catalog_version: string;
          payload?: Json;
          result_order_id?: string | null;
          error_message?: string | null;
          attempt_count?: number;
          last_attempt_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          store_id?: string;
          device_id?: string;
          operation_type?: "create_order";
          status?: "pending" | "processing" | "succeeded" | "failed" | "conflict";
          idempotency_key?: string;
          catalog_version?: string;
          payload?: Json;
          result_order_id?: string | null;
          error_message?: string | null;
          attempt_count?: number;
          last_attempt_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      customers: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          name: string;
          phone: string | null;
          email: string | null;
          price_tier: "retail" | "wholesale" | "agent" | "regular";
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          name: string;
          phone?: string | null;
          email?: string | null;
          price_tier?: "retail" | "wholesale" | "agent" | "regular";
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          store_id?: string;
          name?: string;
          phone?: string | null;
          email?: string | null;
          price_tier?: "retail" | "wholesale" | "agent" | "regular";
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      customer_member_portal_links: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          token: string;
          label: string | null;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          token: string;
          label?: string | null;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          store_id?: string;
          token?: string;
          label?: string | null;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      customer_member_otps: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          portal_link_id: string;
          customer_id: string | null;
          purpose: "register" | "login";
          phone: string;
          email: string | null;
          name: string | null;
          code_hash: string;
          attempts: number;
          expires_at: string;
          consumed_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          portal_link_id: string;
          customer_id?: string | null;
          purpose: "register" | "login";
          phone: string;
          email?: string | null;
          name?: string | null;
          code_hash: string;
          attempts?: number;
          expires_at: string;
          consumed_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          store_id?: string;
          portal_link_id?: string;
          customer_id?: string | null;
          purpose?: "register" | "login";
          phone?: string;
          email?: string | null;
          name?: string | null;
          code_hash?: string;
          attempts?: number;
          expires_at?: string;
          consumed_at?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      customer_member_sessions: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          customer_id: string;
          session_token_hash: string;
          expires_at: string;
          created_at: string;
          last_seen_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          customer_id: string;
          session_token_hash: string;
          expires_at: string;
          created_at?: string;
          last_seen_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          store_id?: string;
          customer_id?: string;
          session_token_hash?: string;
          expires_at?: string;
          created_at?: string;
          last_seen_at?: string;
        };
        Relationships: [];
      };
      coupons: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          code: string;
          normalized_code: string;
          name: string;
          discount_type: "amount" | "percentage";
          discount_value: number;
          min_subtotal: number;
          starts_at: string | null;
          ends_at: string | null;
          max_redemptions: number | null;
          max_redemptions_per_customer: number | null;
          customer_ids: string[];
          stackable_with_manual_discount: boolean;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          code: string;
          normalized_code?: string;
          name: string;
          discount_type: "amount" | "percentage";
          discount_value: number;
          min_subtotal?: number;
          starts_at?: string | null;
          ends_at?: string | null;
          max_redemptions?: number | null;
          max_redemptions_per_customer?: number | null;
          customer_ids?: string[];
          stackable_with_manual_discount?: boolean;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          store_id?: string;
          code?: string;
          normalized_code?: string;
          name?: string;
          discount_type?: "amount" | "percentage";
          discount_value?: number;
          min_subtotal?: number;
          starts_at?: string | null;
          ends_at?: string | null;
          max_redemptions?: number | null;
          max_redemptions_per_customer?: number | null;
          customer_ids?: string[];
          stackable_with_manual_discount?: boolean;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      coupon_redemptions: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          coupon_id: string;
          customer_id: string | null;
          order_id: string;
          discount_amount: number;
          idempotency_key: string;
          voided_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          coupon_id: string;
          customer_id?: string | null;
          order_id: string;
          discount_amount: number;
          idempotency_key: string;
          voided_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          store_id?: string;
          coupon_id?: string;
          customer_id?: string | null;
          order_id?: string;
          discount_amount?: number;
          idempotency_key?: string;
          voided_at?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      loyalty_accounts: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          customer_id: string;
          points_balance: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          customer_id: string;
          points_balance?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          store_id?: string;
          customer_id?: string;
          points_balance?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      loyalty_rewards: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          name: string;
          description: string | null;
          points_cost: number;
          stock_quantity: number | null;
          reward_type: "discount" | "product";
          discount_kind: "amount" | "percentage" | null;
          discount_value: number | null;
          reward_product_id: string | null;
          image_url: string | null;
          code_mode: "auto" | "manual";
          manual_code: string | null;
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
          points_cost: number;
          stock_quantity?: number | null;
          reward_type?: "discount" | "product";
          discount_kind?: "amount" | "percentage" | null;
          discount_value?: number | null;
          reward_product_id?: string | null;
          image_url?: string | null;
          code_mode?: "auto" | "manual";
          manual_code?: string | null;
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
          points_cost?: number;
          stock_quantity?: number | null;
          reward_type?: "discount" | "product";
          discount_kind?: "amount" | "percentage" | null;
          discount_value?: number | null;
          reward_product_id?: string | null;
          image_url?: string | null;
          code_mode?: "auto" | "manual";
          manual_code?: string | null;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      loyalty_reward_redemptions: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          reward_id: string;
          account_id: string;
          customer_id: string;
          points_spent: number;
          status: "pending" | "fulfilled" | "cancelled";
          idempotency_key: string;
          voucher_code: string | null;
          coupon_id: string | null;
          expires_at: string | null;
          used_at: string | null;
          used_order_id: string | null;
          created_at: string;
          fulfilled_at: string | null;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          reward_id: string;
          account_id: string;
          customer_id: string;
          points_spent: number;
          status?: "pending" | "fulfilled" | "cancelled";
          idempotency_key: string;
          voucher_code?: string | null;
          coupon_id?: string | null;
          expires_at?: string | null;
          used_at?: string | null;
          used_order_id?: string | null;
          created_at?: string;
          fulfilled_at?: string | null;
        };
        Update: {
          id?: string;
          organization_id?: string;
          store_id?: string;
          reward_id?: string;
          account_id?: string;
          customer_id?: string;
          points_spent?: number;
          status?: "pending" | "fulfilled" | "cancelled";
          idempotency_key?: string;
          voucher_code?: string | null;
          coupon_id?: string | null;
          expires_at?: string | null;
          used_at?: string | null;
          used_order_id?: string | null;
          created_at?: string;
          fulfilled_at?: string | null;
        };
        Relationships: [];
      };
      pos_coupon_code_attempts: {
        Row: {
          id: string;
          organization_id: string | null;
          store_id: string;
          user_id: string | null;
          code_normalized: string | null;
          succeeded: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id?: string | null;
          store_id: string;
          user_id?: string | null;
          code_normalized?: string | null;
          succeeded: boolean;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string | null;
          store_id?: string;
          user_id?: string | null;
          code_normalized?: string | null;
          succeeded?: boolean;
          created_at?: string;
        };
        Relationships: [];
      };
      loyalty_settings: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          points_per_currency: number;
          earn_enabled: boolean;
          redeem_enabled: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          points_per_currency?: number;
          earn_enabled?: boolean;
          redeem_enabled?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          store_id?: string;
          points_per_currency?: number;
          earn_enabled?: boolean;
          redeem_enabled?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      loyalty_ledger: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          account_id: string;
          customer_id: string;
          order_id: string | null;
          type: "earn" | "redeem" | "reversal" | "adjustment";
          points_delta: number;
          reason: string | null;
          reversed_entry_id: string | null;
          idempotency_key: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          account_id: string;
          customer_id: string;
          order_id?: string | null;
          type: "earn" | "redeem" | "reversal" | "adjustment";
          points_delta: number;
          reason?: string | null;
          reversed_entry_id?: string | null;
          idempotency_key: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          store_id?: string;
          account_id?: string;
          customer_id?: string;
          order_id?: string | null;
          type?: "earn" | "redeem" | "reversal" | "adjustment";
          points_delta?: number;
          reason?: string | null;
          reversed_entry_id?: string | null;
          idempotency_key?: string;
          created_at?: string;
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
          cashier_id: string | null;
          system_account_id: string | null;
          customer_id: string | null;
          coupon_id: string | null;
          coupon_discount_amount: number;
          loyalty_points_earned: number;
          loyalty_points_redeemed: number;
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
          cashier_id?: string | null;
          system_account_id?: string | null;
          customer_id?: string | null;
          coupon_id?: string | null;
          coupon_discount_amount?: number;
          loyalty_points_earned?: number;
          loyalty_points_redeemed?: number;
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
          cashier_id?: string | null;
          system_account_id?: string | null;
          customer_id?: string | null;
          coupon_id?: string | null;
          coupon_discount_amount?: number;
          loyalty_points_earned?: number;
          loyalty_points_redeemed?: number;
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
          kitchen_station_id: string | null;
          kitchen_station_name: string | null;
          unit_id: string | null;
          unit_name: string | null;
          unit_quantity: number;
          modifiers: Json;
          quantity: number;
          unit_price: number;
          total_price: number;
          discount_amount: number;
          discount_type: "amount" | "percentage" | null;
          discount_value: number | null;
          discount_note: string | null;
          note: string | null;
          voided: boolean;
          voided_reason: string | null;
        };
        Insert: {
          id?: string;
          order_id: string;
          product_id: string;
          product_name: string;
          variant_id?: string | null;
          variant_name?: string | null;
          kitchen_station_id?: string | null;
          kitchen_station_name?: string | null;
          unit_id?: string | null;
          unit_name?: string | null;
          unit_quantity?: number;
          modifiers?: Json;
          quantity: number;
          unit_price: number;
          total_price: number;
          discount_amount?: number;
          discount_type?: "amount" | "percentage" | null;
          discount_value?: number | null;
          discount_note?: string | null;
          note?: string | null;
          voided?: boolean;
          voided_reason?: string | null;
        };
        Update: {
          id?: string;
          order_id?: string;
          product_id?: string;
          product_name?: string;
          variant_id?: string | null;
          variant_name?: string | null;
          kitchen_station_id?: string | null;
          kitchen_station_name?: string | null;
          unit_id?: string | null;
          unit_name?: string | null;
          unit_quantity?: number;
          modifiers?: Json;
          quantity?: number;
          unit_price?: number;
          total_price?: number;
          discount_amount?: number;
          discount_type?: "amount" | "percentage" | null;
          discount_value?: number | null;
          discount_note?: string | null;
          note?: string | null;
          voided?: boolean;
          voided_reason?: string | null;
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
          type: "call_staff" | "request_water" | "request_condiment" | "request_bill";
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
          type: "call_staff" | "request_water" | "request_condiment" | "request_bill";
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
      notifications: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string | null;
          type: string;
          title: string | null;
          message: string;
          metadata: Json;
          status: "new" | "acknowledged";
          acknowledged_by: string | null;
          acknowledged_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id?: string | null;
          type: string;
          title?: string | null;
          message: string;
          metadata?: Json;
          status?: "new" | "acknowledged";
          acknowledged_by?: string | null;
          acknowledged_at?: string | null;
          created_at?: string;
        };
        Update: {
          status?: "new" | "acknowledged";
          acknowledged_by?: string | null;
          acknowledged_at?: string | null;
        };
        Relationships: [];
      };
      music_requests: {
        Row: {
          id: string;
          store_id: string;
          organization_id: string;
          table_id: string | null;
          table_number: string | null;
          session_id: string | null;
          requester_label: string | null;
          song_title: string;
          artist_name: string | null;
          note: string | null;
          status: "pending" | "approved" | "played" | "rejected" | "skipped" | "expired";
          requested_at: string;
          decided_at: string | null;
          decided_by: string | null;
          played_at: string | null;
          youtube_video_id: string | null;
          youtube_title: string | null;
          thumbnail_url: string | null;
          duration_seconds: number | null;
          donation_amount: number;
          donation_status: "none" | "pending" | "verified" | "rejected";
          donation_slip_url: string | null;
          donation_ref: string | null;
          donation_play_now: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          store_id: string;
          organization_id: string;
          table_id?: string | null;
          table_number?: string | null;
          session_id?: string | null;
          requester_label?: string | null;
          song_title: string;
          artist_name?: string | null;
          note?: string | null;
          status?: "pending" | "approved" | "played" | "rejected" | "skipped" | "expired";
          requested_at?: string;
          decided_at?: string | null;
          decided_by?: string | null;
          played_at?: string | null;
          youtube_video_id?: string | null;
          youtube_title?: string | null;
          thumbnail_url?: string | null;
          duration_seconds?: number | null;
          donation_amount?: number;
          donation_status?: "none" | "pending" | "verified" | "rejected";
          donation_slip_url?: string | null;
          donation_ref?: string | null;
          donation_play_now?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          status?: "pending" | "approved" | "played" | "rejected" | "skipped" | "expired";
          decided_at?: string | null;
          decided_by?: string | null;
          played_at?: string | null;
          youtube_video_id?: string | null;
          youtube_title?: string | null;
          thumbnail_url?: string | null;
          duration_seconds?: number | null;
          donation_amount?: number;
          donation_status?: "none" | "pending" | "verified" | "rejected";
          donation_slip_url?: string | null;
          donation_ref?: string | null;
          donation_play_now?: boolean;
          updated_at?: string;
        };
        Relationships: [];
      };
      music_request_audit_logs: {
        Row: {
          id: string;
          store_id: string;
          music_request_id: string | null;
          actor_user_id: string | null;
          actor_type: "customer" | "staff" | "system";
          action: string;
          details: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          store_id: string;
          music_request_id?: string | null;
          actor_user_id?: string | null;
          actor_type: "customer" | "staff" | "system";
          action: string;
          details?: Json;
          created_at?: string;
        };
        Update: {
          details?: Json;
        };
        Relationships: [];
      };
      store_music_player_settings: {
        Row: {
          store_id: string;
          organization_id: string;
          player_enabled: boolean;
          auto_approve: boolean;
          donation_enabled: boolean;
          min_donation: number;
          play_now_price: number;
          max_duration_seconds: number;
          base_playlist: Json;
          licensing_acknowledged_at: string | null;
          updated_at: string;
        };
        Insert: {
          store_id: string;
          organization_id: string;
          player_enabled?: boolean;
          auto_approve?: boolean;
          donation_enabled?: boolean;
          min_donation?: number;
          play_now_price?: number;
          max_duration_seconds?: number;
          base_playlist?: Json;
          licensing_acknowledged_at?: string | null;
          updated_at?: string;
        };
        Update: {
          player_enabled?: boolean;
          auto_approve?: boolean;
          donation_enabled?: boolean;
          min_donation?: number;
          play_now_price?: number;
          max_duration_seconds?: number;
          base_playlist?: Json;
          licensing_acknowledged_at?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      store_now_playing: {
        Row: {
          store_id: string;
          music_request_id: string | null;
          source: "request" | "base";
          youtube_video_id: string | null;
          title: string | null;
          duration_seconds: number | null;
          started_at: string;
          updated_at: string;
        };
        Insert: {
          store_id: string;
          music_request_id?: string | null;
          source?: "request" | "base";
          youtube_video_id?: string | null;
          title?: string | null;
          duration_seconds?: number | null;
          started_at?: string;
          updated_at?: string;
        };
        Update: {
          music_request_id?: string | null;
          source?: "request" | "base";
          youtube_video_id?: string | null;
          title?: string | null;
          duration_seconds?: number | null;
          started_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      store_play_history: {
        Row: {
          id: string;
          store_id: string;
          music_request_id: string | null;
          source: "request" | "base";
          youtube_video_id: string | null;
          title: string | null;
          played_at: string;
        };
        Insert: {
          id?: string;
          store_id: string;
          music_request_id?: string | null;
          source?: "request" | "base";
          youtube_video_id?: string | null;
          title?: string | null;
          played_at?: string;
        };
        Update: {
          title?: string | null;
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
          working_days: number[];
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
          working_days?: number[];
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
          working_days?: number[];
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
          footer_image_url: string | null;
          auto_print_receipt: boolean;
          auto_print_station_tickets: boolean;
          paper_width: "58mm" | "80mm";
          print_copies: number;
          show_vat_breakdown: boolean;
          vat_rate: number;
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
          footer_image_url?: string | null;
          auto_print_receipt?: boolean;
          auto_print_station_tickets?: boolean;
          paper_width?: "58mm" | "80mm";
          print_copies?: number;
          show_vat_breakdown?: boolean;
          vat_rate?: number;
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
          footer_image_url?: string | null;
          auto_print_receipt?: boolean;
          auto_print_station_tickets?: boolean;
          paper_width?: "58mm" | "80mm";
          print_copies?: number;
          show_vat_breakdown?: boolean;
          vat_rate?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      customer_display_settings: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          ad_enabled: boolean;
          ad_layout: "single" | "split";
          top_slot_enabled: boolean;
          bottom_slot_enabled: boolean;
          slide_interval_seconds: number;
          top_slides: Json;
          bottom_slides: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          ad_enabled?: boolean;
          ad_layout?: "single" | "split";
          top_slot_enabled?: boolean;
          bottom_slot_enabled?: boolean;
          slide_interval_seconds?: number;
          top_slides?: Json;
          bottom_slides?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          store_id?: string;
          ad_enabled?: boolean;
          ad_layout?: "single" | "split";
          top_slot_enabled?: boolean;
          bottom_slot_enabled?: boolean;
          slide_interval_seconds?: number;
          top_slides?: Json;
          bottom_slides?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      line_account_links: {
        Row: {
          id: string;
          organization_id: string;
          user_id: string;
          line_user_id: string;
          status: "active" | "unlinked";
          linked_at: string;
          unlinked_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          user_id: string;
          line_user_id: string;
          status?: "active" | "unlinked";
          linked_at?: string;
          unlinked_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          user_id?: string;
          line_user_id?: string;
          status?: "active" | "unlinked";
          linked_at?: string;
          unlinked_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      line_account_link_sessions: {
        Row: {
          id: string;
          organization_id: string;
          user_id: string;
          nonce_hash: string;
          expires_at: string;
          consumed_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          user_id: string;
          nonce_hash: string;
          expires_at: string;
          consumed_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          user_id?: string;
          nonce_hash?: string;
          expires_at?: string;
          consumed_at?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      line_notification_targets: {
        Row: {
          id: string;
          organization_id: string;
          target_type: "group" | "room";
          target_id: string;
          status: "active" | "unlinked";
          linked_by: string;
          linked_at: string;
          unlinked_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          target_type: "group" | "room";
          target_id: string;
          status?: "active" | "unlinked";
          linked_by: string;
          linked_at?: string;
          unlinked_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          target_type?: "group" | "room";
          target_id?: string;
          status?: "active" | "unlinked";
          linked_by?: string;
          linked_at?: string;
          unlinked_at?: string | null;
          created_at?: string;
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
      device_push_tokens: {
        Row: {
          id: string;
          user_id: string;
          organization_id: string;
          store_id: string | null;
          platform: "android" | "ios";
          token: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          organization_id: string;
          store_id?: string | null;
          platform: "android" | "ios";
          token: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          organization_id?: string;
          store_id?: string | null;
          platform?: "android" | "ios";
          token?: string;
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
          notification_type: "payment" | "new_table" | "new_pos_order" | "new_qr_order" | "new_buffet_order" | "kitchen_order" | "buffet_expiring" | "stock_alert" | "order_cancelled" | "approval" | "service_request" | "attendance_clock_in" | "attendance_clock_out" | "test";
          channel: "line" | "telegram" | "push";
          enabled: boolean;
          destination: "owner" | "group" | "all";
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          notification_type: "payment" | "new_table" | "new_pos_order" | "new_qr_order" | "new_buffet_order" | "kitchen_order" | "buffet_expiring" | "stock_alert" | "order_cancelled" | "approval" | "service_request" | "attendance_clock_in" | "attendance_clock_out" | "test";
          channel: "line" | "telegram" | "push";
          enabled?: boolean;
          destination?: "owner" | "group" | "all";
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          store_id?: string;
          notification_type?: "payment" | "new_table" | "new_pos_order" | "new_qr_order" | "new_buffet_order" | "kitchen_order" | "buffet_expiring" | "stock_alert" | "order_cancelled" | "approval" | "service_request" | "attendance_clock_in" | "attendance_clock_out" | "test";
          channel?: "line" | "telegram" | "push";
          enabled?: boolean;
          destination?: "owner" | "group" | "all";
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      notification_templates: {
        Row: {
          id: string;
          organization_id: string;
          store_id: string;
          notification_type: "payment" | "new_table" | "new_pos_order" | "new_qr_order" | "new_buffet_order" | "kitchen_order" | "buffet_expiring" | "stock_alert" | "order_cancelled" | "approval" | "service_request" | "attendance_clock_in" | "attendance_clock_out" | "test";
          title: string | null;
          message: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          store_id: string;
          notification_type: "payment" | "new_table" | "new_pos_order" | "new_qr_order" | "new_buffet_order" | "kitchen_order" | "buffet_expiring" | "stock_alert" | "order_cancelled" | "approval" | "service_request" | "attendance_clock_in" | "attendance_clock_out" | "test";
          title?: string | null;
          message?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          store_id?: string;
          notification_type?: "payment" | "new_table" | "new_pos_order" | "new_qr_order" | "new_buffet_order" | "kitchen_order" | "buffet_expiring" | "stock_alert" | "order_cancelled" | "approval" | "service_request" | "attendance_clock_in" | "attendance_clock_out" | "test";
          title?: string | null;
          message?: string | null;
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
          hub_bluetooth_port: string | null;
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
          hub_bluetooth_port?: string | null;
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
          hub_bluetooth_port?: string | null;
          paper_width?: "58mm" | "80mm";
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      adjust_customer_loyalty_points: {
        Args: {
          p_organization_id: string;
          p_store_id: string;
          p_customer_id: string;
          p_points_delta: number;
          p_reason?: string | null;
          p_idempotency_key?: string | null;
        };
        Returns: string;
      };
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
      upsert_line_notification_target: {
        Args: {
          p_organization_id: string;
          p_linked_by: string;
          p_target_type: "group" | "room";
          p_target_id: string;
        };
        Returns: string;
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
      create_pos_order_with_customer_rewards: {
        Args: {
          p_organization_id: string;
          p_store_id: string;
          p_order_number: string;
          p_table_id?: string | null;
          p_table_number?: string | null;
          p_cashier_id?: string | null;
          p_customer_id?: string | null;
          p_coupon_id?: string | null;
          p_coupon_discount_amount?: number;
          p_subtotal?: number;
          p_discount?: number;
          p_discount_note?: string | null;
          p_total?: number;
          p_note?: string | null;
          p_items?: Json;
          p_idempotency_key?: string | null;
        };
        Returns: string;
      };
      create_grocery_pos_order_with_rewards: {
        Args: {
          p_organization_id: string;
          p_store_id: string;
          p_order_number: string;
          p_cashier_id?: string | null;
          p_customer_id?: string | null;
          p_coupon_id?: string | null;
          p_coupon_discount_amount?: number;
          p_subtotal?: number;
          p_discount?: number;
          p_discount_note?: string | null;
          p_total?: number;
          p_note?: string | null;
          p_items?: Json;
          p_idempotency_key?: string | null;
        };
        Returns: string;
      };
      close_grocery_pos_order_payment_with_rewards: {
        Args: {
          p_order_id: string;
          p_store_id: string;
          p_processed_by_user_id: string;
          p_method: string;
          p_amount: number;
          p_received_amount?: number | null;
          p_change_amount?: number | null;
          p_reference?: string | null;
          p_idempotency_key?: string | null;
        };
        Returns: string;
      };
      void_grocery_pos_order_with_rewards: {
        Args: {
          p_order_id: string;
          p_store_id: string;
          p_voided_by_user_id: string;
          p_reason?: string | null;
          p_idempotency_key?: string | null;
        };
        Returns: string;
      };
      replay_grocery_pos_create_order_with_sync: {
        Args: {
          p_organization_id: string;
          p_store_id: string;
          p_device_key: string;
          p_catalog_version: string;
          p_operation_payload: Json;
          p_order_number: string;
          p_cashier_id?: string | null;
          p_customer_id?: string | null;
          p_coupon_id?: string | null;
          p_coupon_discount_amount?: number;
          p_subtotal?: number;
          p_discount?: number;
          p_discount_note?: string | null;
          p_total?: number;
          p_note?: string | null;
          p_items?: Json;
          p_idempotency_key?: string | null;
        };
        Returns: string;
      };
      record_grocery_pos_sync_conflict: {
        Args: {
          p_organization_id: string;
          p_store_id: string;
          p_device_key: string;
          p_catalog_version: string;
          p_operation_payload: Json;
          p_idempotency_key: string;
          p_error_message?: string | null;
        };
        Returns: string;
      };
      redeem_loyalty_reward: {
        Args: {
          p_organization_id: string;
          p_store_id: string;
          p_customer_id: string;
          p_reward_id: string;
          p_idempotency_key: string;
        };
        Returns: Json;
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
      cancel_qr_order_by_customer: {
        Args: { p_store_id: string; p_table_id: string; p_order_id: string };
        Returns: undefined;
      };
      void_qr_order_item: {
        Args: { p_store_id: string; p_order_id: string; p_item_id: string; p_reason?: string | null };
        Returns: undefined;
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
      create_music_request: {
        Args: {
          p_store_id: string;
          p_table_id: string;
          p_session_id: string | null;
          p_song_title: string;
          p_artist_name?: string | null;
          p_requester_label?: string | null;
          p_note?: string | null;
        };
        Returns: string;
      };
      decide_music_request: {
        Args: {
          p_request_id: string;
          p_action: string;
        };
        Returns: undefined;
      };
      open_table_session: {
        Args: { p_store_id: string; p_table_id: string; p_minutes: number | null };
        Returns: string;
      };
      open_table_session_self: {
        Args: { p_store_id: string; p_table_id: string };
        Returns: string;
      };
      close_table_session: {
        Args: { p_store_id: string; p_table_id: string };
        Returns: undefined;
      };
      delete_pos_saved_ticket_and_close_table: {
        Args: { p_ticket_id: string; p_store_id: string };
        Returns: undefined;
      };
      claim_free_trial: {
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
          delivery_order_count: number;
          qr_revenue: number;
          pos_revenue: number;
          delivery_revenue: number;
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
