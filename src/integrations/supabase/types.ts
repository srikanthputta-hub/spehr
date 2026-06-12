export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      clinical_notes: {
        Row: {
          author: string | null
          content: string | null
          created_at: string | null
          id: string
          mrn: string | null
          note_type: string | null
        }
        Insert: {
          author?: string | null
          content?: string | null
          created_at?: string | null
          id?: string
          mrn?: string | null
          note_type?: string | null
        }
        Update: {
          author?: string | null
          content?: string | null
          created_at?: string | null
          id?: string
          mrn?: string | null
          note_type?: string | null
        }
        Relationships: []
      }
      hospital_staff: {
        Row: {
          assigned_patients: number | null
          avatar_url: string | null
          created_at: string | null
          facility_name: string | null
          hourly_rate: number | null
          id: string
          max_capacity: number | null
          name: string
          role: string
          signature_pin: string | null
          status: string | null
        }
        Insert: {
          assigned_patients?: number | null
          avatar_url?: string | null
          created_at?: string | null
          facility_name?: string | null
          hourly_rate?: number | null
          id?: string
          max_capacity?: number | null
          name: string
          role: string
          signature_pin?: string | null
          status?: string | null
        }
        Update: {
          assigned_patients?: number | null
          avatar_url?: string | null
          created_at?: string | null
          facility_name?: string | null
          hourly_rate?: number | null
          id?: string
          max_capacity?: number | null
          name?: string
          role?: string
          signature_pin?: string | null
          status?: string | null
        }
        Relationships: []
      }
      lab_orders: {
        Row: {
          clinical_condition: string | null
          collected_at: string | null
          created_at: string | null
          facility_name: string
          id: string
          ordered_by: string | null
          patient_mrn: string
          patient_name: string
          requested_by: string
          result_value: string | null
          resulted_at: string | null
          results_data: Json | null
          status: string | null
          test_type: string
        }
        Insert: {
          clinical_condition?: string | null
          collected_at?: string | null
          created_at?: string | null
          facility_name: string
          id?: string
          ordered_by?: string | null
          patient_mrn: string
          patient_name: string
          requested_by: string
          result_value?: string | null
          resulted_at?: string | null
          results_data?: Json | null
          status?: string | null
          test_type: string
        }
        Update: {
          clinical_condition?: string | null
          collected_at?: string | null
          created_at?: string | null
          facility_name?: string
          id?: string
          ordered_by?: string | null
          patient_mrn?: string
          patient_name?: string
          requested_by?: string
          result_value?: string | null
          resulted_at?: string | null
          results_data?: Json | null
          status?: string | null
          test_type?: string
        }
        Relationships: []
      }
      lab_results: {
        Row: {
          flag: string | null
          id: string
          mrn: string | null
          panel_name: string | null
          reference_range: string | null
          result_value: number | null
          test_name: string | null
          time_drawn: string | null
          unit: string | null
        }
        Insert: {
          flag?: string | null
          id?: string
          mrn?: string | null
          panel_name?: string | null
          reference_range?: string | null
          result_value?: number | null
          test_name?: string | null
          time_drawn?: string | null
          unit?: string | null
        }
        Update: {
          flag?: string | null
          id?: string
          mrn?: string | null
          panel_name?: string | null
          reference_range?: string | null
          result_value?: number | null
          test_name?: string | null
          time_drawn?: string | null
          unit?: string | null
        }
        Relationships: []
      }
      mar_logs: {
        Row: {
          administered_at: string | null
          administered_by: string | null
          given_at: string | null
          given_by: string | null
          id: string
          medication_name: string | null
          mrn: string | null
          patient_mrn: string | null
        }
        Insert: {
          administered_at?: string | null
          administered_by?: string | null
          given_at?: string | null
          given_by?: string | null
          id?: string
          medication_name?: string | null
          mrn?: string | null
          patient_mrn?: string | null
        }
        Update: {
          administered_at?: string | null
          administered_by?: string | null
          given_at?: string | null
          given_by?: string | null
          id?: string
          medication_name?: string | null
          mrn?: string | null
          patient_mrn?: string | null
        }
        Relationships: []
      }
      medical_terminology: {
        Row: {
          category: string | null
          code: string
          code_system: string
          created_at: string
          description: string | null
          display: string
          id: string
          status: string
          updated_at: string
        }
        Insert: {
          category?: string | null
          code: string
          code_system: string
          created_at?: string
          description?: string | null
          display: string
          id?: string
          status?: string
          updated_at?: string
        }
        Update: {
          category?: string | null
          code?: string
          code_system?: string
          created_at?: string
          description?: string | null
          display?: string
          id?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      medication_orders: {
        Row: {
          administered_at: string | null
          approved_at: string | null
          created_at: string | null
          dispensed_at: string | null
          dose: string | null
          drug: string | null
          drug_name: string | null
          facility_name: string | null
          frequency: string | null
          id: string
          medication: string | null
          medication_name: string | null
          mrn: string | null
          name: string | null
          ordered_by: string | null
          ordering_physician: string | null
          patient_id: string | null
          patient_mrn: string | null
          patient_name: string | null
          route: string | null
          status: string | null
        }
        Insert: {
          administered_at?: string | null
          approved_at?: string | null
          created_at?: string | null
          dispensed_at?: string | null
          dose?: string | null
          drug?: string | null
          drug_name?: string | null
          facility_name?: string | null
          frequency?: string | null
          id?: string
          medication?: string | null
          medication_name?: string | null
          mrn?: string | null
          name?: string | null
          ordered_by?: string | null
          ordering_physician?: string | null
          patient_id?: string | null
          patient_mrn?: string | null
          patient_name?: string | null
          route?: string | null
          status?: string | null
        }
        Update: {
          administered_at?: string | null
          approved_at?: string | null
          created_at?: string | null
          dispensed_at?: string | null
          dose?: string | null
          drug?: string | null
          drug_name?: string | null
          facility_name?: string | null
          frequency?: string | null
          id?: string
          medication?: string | null
          medication_name?: string | null
          mrn?: string | null
          name?: string | null
          ordered_by?: string | null
          ordering_physician?: string | null
          patient_id?: string | null
          patient_mrn?: string | null
          patient_name?: string | null
          route?: string | null
          status?: string | null
        }
        Relationships: []
      }
      nurse_assignments: {
        Row: {
          assigned_at: string | null
          id: string
          nurse_name: string | null
          room_cluster: string | null
        }
        Insert: {
          assigned_at?: string | null
          id?: string
          nurse_name?: string | null
          room_cluster?: string | null
        }
        Update: {
          assigned_at?: string | null
          id?: string
          nurse_name?: string | null
          room_cluster?: string | null
        }
        Relationships: []
      }
      patient_notes: {
        Row: {
          assessment: string | null
          author_name: string
          background: string | null
          created_at: string | null
          esigned_at: string | null
          facility_name: string
          id: string
          patient_mrn: string
          patient_name: string
          recommendation: string | null
          situation: string | null
          status: string | null
          verification_pin_hash: string | null
        }
        Insert: {
          assessment?: string | null
          author_name: string
          background?: string | null
          created_at?: string | null
          esigned_at?: string | null
          facility_name: string
          id?: string
          patient_mrn: string
          patient_name: string
          recommendation?: string | null
          situation?: string | null
          status?: string | null
          verification_pin_hash?: string | null
        }
        Update: {
          assessment?: string | null
          author_name?: string
          background?: string | null
          created_at?: string | null
          esigned_at?: string | null
          facility_name?: string
          id?: string
          patient_mrn?: string
          patient_name?: string
          recommendation?: string | null
          situation?: string | null
          status?: string | null
          verification_pin_hash?: string | null
        }
        Relationships: []
      }
      patient_transfers: {
        Row: {
          created_at: string | null
          destination_facility: string
          id: string
          patient_mrn: string
          patient_name: string
          reason_for_transfer: string | null
          requesting_physician: string
          source_facility: string
          status: string | null
        }
        Insert: {
          created_at?: string | null
          destination_facility: string
          id?: string
          patient_mrn: string
          patient_name: string
          reason_for_transfer?: string | null
          requesting_physician: string
          source_facility: string
          status?: string | null
        }
        Update: {
          created_at?: string | null
          destination_facility?: string
          id?: string
          patient_mrn?: string
          patient_name?: string
          reason_for_transfer?: string | null
          requesting_physician?: string
          source_facility?: string
          status?: string | null
        }
        Relationships: []
      }
      patients: {
        Row: {
          admission_time: string | null
          age: number | null
          bp: string | null
          bp_diastolic: number | null
          bp_systolic: number | null
          chief_complaint: string | null
          code_status: string | null
          diagnosis: string | null
          discharge_summary: string | null
          discharge_time: string | null
          facility_name: string
          first_name: string | null
          gender: string | null
          hr: number | null
          id: string
          last_name: string | null
          meds_due_count: number | null
          mrn: string | null
          name: string | null
          patient_id: string | null
          room: string | null
          rr: number | null
          spo2: number | null
          status: string
          temp: number | null
          unread_labs_alert: boolean | null
        }
        Insert: {
          admission_time?: string | null
          age?: number | null
          bp?: string | null
          bp_diastolic?: number | null
          bp_systolic?: number | null
          chief_complaint?: string | null
          code_status?: string | null
          diagnosis?: string | null
          discharge_summary?: string | null
          discharge_time?: string | null
          facility_name?: string
          first_name?: string | null
          gender?: string | null
          hr?: number | null
          id?: string
          last_name?: string | null
          meds_due_count?: number | null
          mrn?: string | null
          name?: string | null
          patient_id?: string | null
          room?: string | null
          rr?: number | null
          spo2?: number | null
          status?: string
          temp?: number | null
          unread_labs_alert?: boolean | null
        }
        Update: {
          admission_time?: string | null
          age?: number | null
          bp?: string | null
          bp_diastolic?: number | null
          bp_systolic?: number | null
          chief_complaint?: string | null
          code_status?: string | null
          diagnosis?: string | null
          discharge_summary?: string | null
          discharge_time?: string | null
          facility_name?: string
          first_name?: string | null
          gender?: string | null
          hr?: number | null
          id?: string
          last_name?: string | null
          meds_due_count?: number | null
          mrn?: string | null
          name?: string | null
          patient_id?: string | null
          room?: string | null
          rr?: number | null
          spo2?: number | null
          status?: string
          temp?: number | null
          unread_labs_alert?: boolean | null
        }
        Relationships: []
      }
      profiles: {
        Row: {
          branch: Database["public"]["Enums"]["branch"]
          created_at: string
          email: string
          id: string
          updated_at: string
        }
        Insert: {
          branch: Database["public"]["Enums"]["branch"]
          created_at?: string
          email: string
          id: string
          updated_at?: string
        }
        Update: {
          branch?: Database["public"]["Enums"]["branch"]
          created_at?: string
          email?: string
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      provider_notes: {
        Row: {
          author_name: string | null
          author_role: string | null
          content: string
          id: string
          note_type: string
          patient_mrn: string
          signed_at: string | null
        }
        Insert: {
          author_name?: string | null
          author_role?: string | null
          content: string
          id?: string
          note_type: string
          patient_mrn: string
          signed_at?: string | null
        }
        Update: {
          author_name?: string | null
          author_role?: string | null
          content?: string
          id?: string
          note_type?: string
          patient_mrn?: string
          signed_at?: string | null
        }
        Relationships: []
      }
      role_permissions: {
        Row: {
          facility_name: string
          feature_key: string
          feature_name: string
          id: string
          is_active: boolean | null
          target_role: string
          updated_at: string | null
        }
        Insert: {
          facility_name: string
          feature_key: string
          feature_name: string
          id?: string
          is_active?: boolean | null
          target_role: string
          updated_at?: string | null
        }
        Update: {
          facility_name?: string
          feature_key?: string
          feature_name?: string
          id?: string
          is_active?: boolean | null
          target_role?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      shift_notes: {
        Row: {
          author_nurse: string | null
          created_at: string | null
          esigned_at: string | null
          id: string
          note_text: string
          patient_mrn: string
          sbar_assessment: string | null
          sbar_background: string | null
          sbar_recommendation: string | null
          sbar_situation: string | null
          status: string
        }
        Insert: {
          author_nurse?: string | null
          created_at?: string | null
          esigned_at?: string | null
          id?: string
          note_text: string
          patient_mrn: string
          sbar_assessment?: string | null
          sbar_background?: string | null
          sbar_recommendation?: string | null
          sbar_situation?: string | null
          status?: string
        }
        Update: {
          author_nurse?: string | null
          created_at?: string | null
          esigned_at?: string | null
          id?: string
          note_text?: string
          patient_mrn?: string
          sbar_assessment?: string | null
          sbar_background?: string | null
          sbar_recommendation?: string | null
          sbar_situation?: string | null
          status?: string
        }
        Relationships: []
      }
      system_settings: {
        Row: {
          automation_enabled: boolean | null
          id: number
        }
        Insert: {
          automation_enabled?: boolean | null
          id: number
        }
        Update: {
          automation_enabled?: boolean | null
          id?: number
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      auto_administer_ghost_meds: { Args: never; Returns: undefined }
      auto_admit_ghost_patient: { Args: never; Returns: undefined }
      auto_discharge_ghost_patients: { Args: never; Returns: undefined }
      auto_order_ghost_labs: { Args: never; Returns: undefined }
      auto_result_ghost_labs: { Args: never; Returns: undefined }
      cascade_clinical_automation: { Args: never; Returns: undefined }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "registrar" | "nurse" | "physician" | "it_admin"
      branch:
        | "memorial_hospital"
        | "ambulatory_center"
        | "women_children"
        | "regional_clinic"
        | "rehab"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["registrar", "nurse", "physician", "it_admin"],
      branch: [
        "memorial_hospital",
        "ambulatory_center",
        "women_children",
        "regional_clinic",
        "rehab",
      ],
    },
  },
} as const
