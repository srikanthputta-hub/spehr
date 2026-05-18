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
      medication_orders: {
        Row: {
          administered_by: string | null
          dose: string | null
          drug_name: string | null
          frequency: string | null
          id: string
          mrn: string | null
          route: string | null
          status: string | null
          time_administered: string | null
        }
        Insert: {
          administered_by?: string | null
          dose?: string | null
          drug_name?: string | null
          frequency?: string | null
          id?: string
          mrn?: string | null
          route?: string | null
          status?: string | null
          time_administered?: string | null
        }
        Update: {
          administered_by?: string | null
          dose?: string | null
          drug_name?: string | null
          frequency?: string | null
          id?: string
          mrn?: string | null
          route?: string | null
          status?: string | null
          time_administered?: string | null
        }
        Relationships: []
      }
      patients: {
        Row: {
          age: number | null
          bp: string | null
          bp_diastolic: number | null
          bp_systolic: number | null
          chief_complaint: string | null
          code_status: string | null
          diagnosis: string | null
          first_name: string | null
          gender: string | null
          hr: number | null
          id: string
          last_name: string | null
          mrn: string | null
          name: string | null
          room: string | null
          rr: number | null
          spo2: number | null
          temp: number | null
        }
        Insert: {
          age?: number | null
          bp?: string | null
          bp_diastolic?: number | null
          bp_systolic?: number | null
          chief_complaint?: string | null
          code_status?: string | null
          diagnosis?: string | null
          first_name?: string | null
          gender?: string | null
          hr?: number | null
          id?: string
          last_name?: string | null
          mrn?: string | null
          name?: string | null
          room?: string | null
          rr?: number | null
          spo2?: number | null
          temp?: number | null
        }
        Update: {
          age?: number | null
          bp?: string | null
          bp_diastolic?: number | null
          bp_systolic?: number | null
          chief_complaint?: string | null
          code_status?: string | null
          diagnosis?: string | null
          first_name?: string | null
          gender?: string | null
          hr?: number | null
          id?: string
          last_name?: string | null
          mrn?: string | null
          name?: string | null
          room?: string | null
          rr?: number | null
          spo2?: number | null
          temp?: number | null
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
