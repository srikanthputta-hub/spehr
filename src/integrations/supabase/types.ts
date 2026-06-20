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
      allergies: {
        Row: {
          author_id: string | null
          created_at: string
          created_by_type: Database["public"]["Enums"]["provenance_origin"]
          id: string
          logged_at: string | null
          mrn: string | null
          reaction: string | null
          severity: string | null
          status: string | null
          substance: string
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          id?: string
          logged_at?: string | null
          mrn?: string | null
          reaction?: string | null
          severity?: string | null
          status?: string | null
          substance: string
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          id?: string
          logged_at?: string | null
          mrn?: string | null
          reaction?: string | null
          severity?: string | null
          status?: string | null
          substance?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "allergies_mrn_fkey"
            columns: ["mrn"]
            isOneToOne: false
            referencedRelation: "fhir_export_view"
            referencedColumns: ["mrn"]
          },
          {
            foreignKeyName: "allergies_mrn_fkey"
            columns: ["mrn"]
            isOneToOne: false
            referencedRelation: "fhir_patient_view"
            referencedColumns: ["mrn"]
          },
          {
            foreignKeyName: "allergies_mrn_fkey"
            columns: ["mrn"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["mrn"]
          },
          {
            foreignKeyName: "allergies_mrn_fkey"
            columns: ["mrn"]
            isOneToOne: false
            referencedRelation: "unified_patient_view"
            referencedColumns: ["mrn"]
          },
        ]
      }
      auto_doc_logs: {
        Row: {
          author_id: string | null
          created_at: string
          created_by_type: Database["public"]["Enums"]["provenance_origin"]
          id: string
          level: string
          message: string
          meta: Json | null
          mrn: string
          stage: string
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          id?: string
          level?: string
          message: string
          meta?: Json | null
          mrn: string
          stage: string
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          id?: string
          level?: string
          message?: string
          meta?: Json | null
          mrn?: string
          stage?: string
          updated_at?: string
        }
        Relationships: []
      }
      auto_doc_runs: {
        Row: {
          author_id: string | null
          completed_at: string | null
          created_at: string
          created_by_type: Database["public"]["Enums"]["provenance_origin"]
          department: string | null
          error: string | null
          mrn: string
          stage: string
          started_at: string
          status: string
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          completed_at?: string | null
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          department?: string | null
          error?: string | null
          mrn: string
          stage?: string
          started_at?: string
          status?: string
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          completed_at?: string | null
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          department?: string | null
          error?: string | null
          mrn?: string
          stage?: string
          started_at?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      automation_watchdog_logs: {
        Row: {
          actions_taken: string | null
          checker_timestamp: string | null
          engines_checked: Json
          global_control_status: string | null
          healed_engines: string[] | null
          id: string
          issues_detected: boolean | null
        }
        Insert: {
          actions_taken?: string | null
          checker_timestamp?: string | null
          engines_checked: Json
          global_control_status?: string | null
          healed_engines?: string[] | null
          id?: string
          issues_detected?: boolean | null
        }
        Update: {
          actions_taken?: string | null
          checker_timestamp?: string | null
          engines_checked?: Json
          global_control_status?: string | null
          healed_engines?: string[] | null
          id?: string
          issues_detected?: boolean | null
        }
        Relationships: []
      }
      bed_management: {
        Row: {
          author_id: string | null
          bed_letter: string
          created_at: string
          created_by_type: Database["public"]["Enums"]["provenance_origin"]
          current_patient_mrn: string | null
          facility_name: string
          id: string
          room_number: string
          status: string | null
          status_updated_at: string | null
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          bed_letter: string
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          current_patient_mrn?: string | null
          facility_name: string
          id?: string
          room_number: string
          status?: string | null
          status_updated_at?: string | null
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          bed_letter?: string
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          current_patient_mrn?: string | null
          facility_name?: string
          id?: string
          room_number?: string
          status?: string | null
          status_updated_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      clinical_keyword_mappings: {
        Row: {
          author_id: string | null
          category: string | null
          created_at: string | null
          created_by_type: Database["public"]["Enums"]["provenance_origin"]
          icd10_array: Json
          id: string
          is_active: boolean | null
          keyword: string
          snomed_array: Json
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          category?: string | null
          created_at?: string | null
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          icd10_array?: Json
          id?: string
          is_active?: boolean | null
          keyword: string
          snomed_array?: Json
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          category?: string | null
          created_at?: string | null
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          icd10_array?: Json
          id?: string
          is_active?: boolean | null
          keyword?: string
          snomed_array?: Json
          updated_at?: string
        }
        Relationships: []
      }
      clinical_notes: {
        Row: {
          author: string | null
          author_id: string | null
          content: string | null
          created_at: string | null
          created_by_type: Database["public"]["Enums"]["provenance_origin"]
          id: string
          mrn: string | null
          note_type: string | null
          updated_at: string
        }
        Insert: {
          author?: string | null
          author_id?: string | null
          content?: string | null
          created_at?: string | null
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          id?: string
          mrn?: string | null
          note_type?: string | null
          updated_at?: string
        }
        Update: {
          author?: string | null
          author_id?: string | null
          content?: string | null
          created_at?: string | null
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          id?: string
          mrn?: string | null
          note_type?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      clinical_safety_alerts: {
        Row: {
          allergy_name: string | null
          author_id: string | null
          auto_resolve_at: string | null
          created_at: string
          created_by_type: Database["public"]["Enums"]["provenance_origin"]
          decided_at: string | null
          decided_by: string | null
          drug: string
          drug_b: string | null
          facility_name: string | null
          family: string
          id: string
          kind: string
          mrn: string
          patient_name: string | null
          rationale: string | null
          resolution_rationale: string | null
          resolved_by: string | null
          severity: string | null
          status: string
          updated_at: string
        }
        Insert: {
          allergy_name?: string | null
          author_id?: string | null
          auto_resolve_at?: string | null
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          decided_at?: string | null
          decided_by?: string | null
          drug: string
          drug_b?: string | null
          facility_name?: string | null
          family: string
          id?: string
          kind: string
          mrn: string
          patient_name?: string | null
          rationale?: string | null
          resolution_rationale?: string | null
          resolved_by?: string | null
          severity?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          allergy_name?: string | null
          author_id?: string | null
          auto_resolve_at?: string | null
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          decided_at?: string | null
          decided_by?: string | null
          drug?: string
          drug_b?: string | null
          facility_name?: string | null
          family?: string
          id?: string
          kind?: string
          mrn?: string
          patient_name?: string | null
          rationale?: string | null
          resolution_rationale?: string | null
          resolved_by?: string | null
          severity?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      data_provenance: {
        Row: {
          author_id: string | null
          author_label: string | null
          created_at: string
          id: number
          operation: string
          origin: Database["public"]["Enums"]["provenance_origin"]
          payload: Json | null
          row_id: string | null
          table_name: string
        }
        Insert: {
          author_id?: string | null
          author_label?: string | null
          created_at?: string
          id?: number
          operation: string
          origin?: Database["public"]["Enums"]["provenance_origin"]
          payload?: Json | null
          row_id?: string | null
          table_name: string
        }
        Update: {
          author_id?: string | null
          author_label?: string | null
          created_at?: string
          id?: number
          operation?: string
          origin?: Database["public"]["Enums"]["provenance_origin"]
          payload?: Json | null
          row_id?: string | null
          table_name?: string
        }
        Relationships: []
      }
      fhir_medication_requests: {
        Row: {
          author_id: string | null
          created_at: string | null
          created_by_type: Database["public"]["Enums"]["provenance_origin"]
          id: string
          patient_mrn: string
          resource: Json
          status: string
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          created_at?: string | null
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          id?: string
          patient_mrn: string
          resource: Json
          status: string
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          created_at?: string | null
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          id?: string
          patient_mrn?: string
          resource?: Json
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "fhir_medication_requests_patient_mrn_fkey"
            columns: ["patient_mrn"]
            isOneToOne: false
            referencedRelation: "fhir_patients"
            referencedColumns: ["mrn"]
          },
        ]
      }
      fhir_observations: {
        Row: {
          author_id: string | null
          code: string
          created_at: string | null
          created_by_type: Database["public"]["Enums"]["provenance_origin"]
          id: string
          patient_mrn: string
          resource: Json
          status: string
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          code: string
          created_at?: string | null
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          id?: string
          patient_mrn: string
          resource: Json
          status: string
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          code?: string
          created_at?: string | null
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          id?: string
          patient_mrn?: string
          resource?: Json
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "fhir_observations_patient_mrn_fkey"
            columns: ["patient_mrn"]
            isOneToOne: false
            referencedRelation: "fhir_patients"
            referencedColumns: ["mrn"]
          },
        ]
      }
      fhir_patients: {
        Row: {
          author_id: string | null
          created_at: string | null
          created_by_type: Database["public"]["Enums"]["provenance_origin"]
          id: string
          mrn: string
          resource: Json
          updated_at: string | null
        }
        Insert: {
          author_id?: string | null
          created_at?: string | null
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          id?: string
          mrn: string
          resource: Json
          updated_at?: string | null
        }
        Update: {
          author_id?: string | null
          created_at?: string | null
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          id?: string
          mrn?: string
          resource?: Json
          updated_at?: string | null
        }
        Relationships: []
      }
      fhir_resources: {
        Row: {
          author_id: string | null
          created_at: string
          created_by_type: Database["public"]["Enums"]["provenance_origin"]
          id: string
          mrn: string | null
          payload: Json
          resource_id: string | null
          resource_type: string
          source: string | null
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          id?: string
          mrn?: string | null
          payload: Json
          resource_id?: string | null
          resource_type: string
          source?: string | null
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          id?: string
          mrn?: string | null
          payload?: Json
          resource_id?: string | null
          resource_type?: string
          source?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      hospital_staff: {
        Row: {
          assigned_patients: number | null
          author_id: string | null
          avatar_url: string | null
          created_at: string | null
          created_by_type: Database["public"]["Enums"]["provenance_origin"]
          facility_name: string | null
          hourly_rate: number | null
          id: string
          max_capacity: number | null
          name: string
          role: string
          signature_pin: string | null
          status: string | null
          updated_at: string
        }
        Insert: {
          assigned_patients?: number | null
          author_id?: string | null
          avatar_url?: string | null
          created_at?: string | null
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          facility_name?: string | null
          hourly_rate?: number | null
          id?: string
          max_capacity?: number | null
          name: string
          role: string
          signature_pin?: string | null
          status?: string | null
          updated_at?: string
        }
        Update: {
          assigned_patients?: number | null
          author_id?: string | null
          avatar_url?: string | null
          created_at?: string | null
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          facility_name?: string | null
          hourly_rate?: number | null
          id?: string
          max_capacity?: number | null
          name?: string
          role?: string
          signature_pin?: string | null
          status?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      lab_orders: {
        Row: {
          author_id: string | null
          clinical_condition: string | null
          collected_at: string | null
          created_at: string | null
          created_by_type: Database["public"]["Enums"]["provenance_origin"]
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
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          clinical_condition?: string | null
          collected_at?: string | null
          created_at?: string | null
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
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
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          clinical_condition?: string | null
          collected_at?: string | null
          created_at?: string | null
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
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
          updated_at?: string
        }
        Relationships: []
      }
      lab_results: {
        Row: {
          author_id: string | null
          created_at: string
          created_by_type: Database["public"]["Enums"]["provenance_origin"]
          flag: string | null
          id: string
          mrn: string | null
          panel_name: string | null
          reference_range: string | null
          result_value: string | null
          test_name: string | null
          time_drawn: string | null
          unit: string | null
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          flag?: string | null
          id?: string
          mrn?: string | null
          panel_name?: string | null
          reference_range?: string | null
          result_value?: string | null
          test_name?: string | null
          time_drawn?: string | null
          unit?: string | null
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          flag?: string | null
          id?: string
          mrn?: string | null
          panel_name?: string | null
          reference_range?: string | null
          result_value?: string | null
          test_name?: string | null
          time_drawn?: string | null
          unit?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      mar_logs: {
        Row: {
          administered_at: string | null
          administered_by: string | null
          author_id: string | null
          created_at: string
          created_by_type: Database["public"]["Enums"]["provenance_origin"]
          given_at: string | null
          given_by: string | null
          id: string
          medication_name: string | null
          mrn: string | null
          patient_mrn: string | null
          updated_at: string
        }
        Insert: {
          administered_at?: string | null
          administered_by?: string | null
          author_id?: string | null
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          given_at?: string | null
          given_by?: string | null
          id?: string
          medication_name?: string | null
          mrn?: string | null
          patient_mrn?: string | null
          updated_at?: string
        }
        Update: {
          administered_at?: string | null
          administered_by?: string | null
          author_id?: string | null
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          given_at?: string | null
          given_by?: string | null
          id?: string
          medication_name?: string | null
          mrn?: string | null
          patient_mrn?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      medical_terminology: {
        Row: {
          author_id: string | null
          category: string | null
          code: string
          code_system: string
          created_at: string
          created_by_type: Database["public"]["Enums"]["provenance_origin"]
          description: string | null
          display: string
          id: string
          status: string
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          category?: string | null
          code: string
          code_system: string
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          description?: string | null
          display: string
          id?: string
          status?: string
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          category?: string | null
          code?: string
          code_system?: string
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
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
          author_id: string | null
          created_at: string | null
          created_by_type: Database["public"]["Enums"]["provenance_origin"]
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
          updated_at: string
        }
        Insert: {
          administered_at?: string | null
          approved_at?: string | null
          author_id?: string | null
          created_at?: string | null
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
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
          updated_at?: string
        }
        Update: {
          administered_at?: string | null
          approved_at?: string | null
          author_id?: string | null
          created_at?: string | null
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
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
          updated_at?: string
        }
        Relationships: []
      }
      nlp_audit_logs: {
        Row: {
          author_id: string | null
          auto_resolve_at: string | null
          confidence_score: number | null
          created_at: string | null
          created_by_type: Database["public"]["Enums"]["provenance_origin"]
          extraction_mapping: string
          id: string
          patient_mrn: string
          raw_text: string
          resolution_method: string | null
          standardized_output: Json
          status: string | null
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          auto_resolve_at?: string | null
          confidence_score?: number | null
          created_at?: string | null
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          extraction_mapping: string
          id?: string
          patient_mrn: string
          raw_text: string
          resolution_method?: string | null
          standardized_output: Json
          status?: string | null
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          auto_resolve_at?: string | null
          confidence_score?: number | null
          created_at?: string | null
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          extraction_mapping?: string
          id?: string
          patient_mrn?: string
          raw_text?: string
          resolution_method?: string | null
          standardized_output?: Json
          status?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      nlp_custom_rules: {
        Row: {
          author_id: string | null
          canonical_mapping: string | null
          created_at: string
          created_by_type: Database["public"]["Enums"]["provenance_origin"]
          id: string
          preferred_form: string | null
          raw_term: string
          type: string
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          canonical_mapping?: string | null
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          id?: string
          preferred_form?: string | null
          raw_term: string
          type: string
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          canonical_mapping?: string | null
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          id?: string
          preferred_form?: string | null
          raw_term?: string
          type?: string
          updated_at?: string
        }
        Relationships: []
      }
      nurse_assignments: {
        Row: {
          assigned_at: string | null
          author_id: string | null
          created_at: string
          created_by_type: Database["public"]["Enums"]["provenance_origin"]
          id: string
          nurse_name: string | null
          room_cluster: string | null
          updated_at: string
        }
        Insert: {
          assigned_at?: string | null
          author_id?: string | null
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          id?: string
          nurse_name?: string | null
          room_cluster?: string | null
          updated_at?: string
        }
        Update: {
          assigned_at?: string | null
          author_id?: string | null
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          id?: string
          nurse_name?: string | null
          room_cluster?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      patient_notes: {
        Row: {
          assessment: string | null
          author_id: string | null
          author_name: string
          background: string | null
          created_at: string | null
          created_by_type: Database["public"]["Enums"]["provenance_origin"]
          esigned_at: string | null
          facility_name: string
          id: string
          patient_mrn: string
          patient_name: string
          recommendation: string | null
          situation: string | null
          status: string | null
          updated_at: string
          verification_pin_hash: string | null
        }
        Insert: {
          assessment?: string | null
          author_id?: string | null
          author_name: string
          background?: string | null
          created_at?: string | null
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          esigned_at?: string | null
          facility_name: string
          id?: string
          patient_mrn: string
          patient_name: string
          recommendation?: string | null
          situation?: string | null
          status?: string | null
          updated_at?: string
          verification_pin_hash?: string | null
        }
        Update: {
          assessment?: string | null
          author_id?: string | null
          author_name?: string
          background?: string | null
          created_at?: string | null
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          esigned_at?: string | null
          facility_name?: string
          id?: string
          patient_mrn?: string
          patient_name?: string
          recommendation?: string | null
          situation?: string | null
          status?: string | null
          updated_at?: string
          verification_pin_hash?: string | null
        }
        Relationships: []
      }
      patient_transfers: {
        Row: {
          author_id: string | null
          created_at: string | null
          created_by_type: Database["public"]["Enums"]["provenance_origin"]
          destination_facility: string
          id: string
          patient_mrn: string
          patient_name: string
          reason_for_transfer: string | null
          requesting_physician: string
          source_facility: string
          status: string | null
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          created_at?: string | null
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          destination_facility: string
          id?: string
          patient_mrn: string
          patient_name: string
          reason_for_transfer?: string | null
          requesting_physician: string
          source_facility: string
          status?: string | null
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          created_at?: string | null
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          destination_facility?: string
          id?: string
          patient_mrn?: string
          patient_name?: string
          reason_for_transfer?: string | null
          requesting_physician?: string
          source_facility?: string
          status?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      patients: {
        Row: {
          address: string | null
          admission_time: string | null
          age: number | null
          allergies: string | null
          assigned_department: string | null
          author_id: string | null
          biological_sex: string
          bp: string | null
          bp_diastolic: number | null
          bp_systolic: number | null
          chief_complaint: string | null
          code_status: string | null
          created_at: string
          created_by_type: Database["public"]["Enums"]["provenance_origin"]
          current_medications: string | null
          diagnosis: string | null
          discharge_summary: string | null
          discharge_time: string | null
          dob: string
          emergency_contact_name: string | null
          emergency_contact_phone: string | null
          emergency_contact_relationship: string | null
          environmental_allergies: string | null
          facility_name: string
          family_history: string | null
          first_name: string | null
          gender: string
          gender_identity: string | null
          guarantor: string | null
          hpi_aggravating_factors: string | null
          hpi_alleviating_factors: string | null
          hpi_character: string | null
          hpi_duration: string | null
          hpi_location: string | null
          hpi_onset: string | null
          hpi_severity: string | null
          hr: number | null
          icd10_codes: string[]
          id: string
          insurance_policy_number: string | null
          insurance_provider: string | null
          last_name: string | null
          meds_due_count: number | null
          mrn: string | null
          name: string | null
          occupation: string | null
          past_hospitalizations: string | null
          past_medical_history: string | null
          past_surgical_history: string | null
          patient_id: string | null
          phone: string | null
          primary_care_physician: string | null
          room: string | null
          rr: number | null
          snomed_codes: string[]
          spo2: number | null
          standardized_output: Json | null
          status: string
          temp: number | null
          unread_labs_alert: boolean | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          admission_time?: string | null
          age?: number | null
          allergies?: string | null
          assigned_department?: string | null
          author_id?: string | null
          biological_sex?: string
          bp?: string | null
          bp_diastolic?: number | null
          bp_systolic?: number | null
          chief_complaint?: string | null
          code_status?: string | null
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          current_medications?: string | null
          diagnosis?: string | null
          discharge_summary?: string | null
          discharge_time?: string | null
          dob?: string
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          emergency_contact_relationship?: string | null
          environmental_allergies?: string | null
          facility_name?: string
          family_history?: string | null
          first_name?: string | null
          gender?: string
          gender_identity?: string | null
          guarantor?: string | null
          hpi_aggravating_factors?: string | null
          hpi_alleviating_factors?: string | null
          hpi_character?: string | null
          hpi_duration?: string | null
          hpi_location?: string | null
          hpi_onset?: string | null
          hpi_severity?: string | null
          hr?: number | null
          icd10_codes?: string[]
          id?: string
          insurance_policy_number?: string | null
          insurance_provider?: string | null
          last_name?: string | null
          meds_due_count?: number | null
          mrn?: string | null
          name?: string | null
          occupation?: string | null
          past_hospitalizations?: string | null
          past_medical_history?: string | null
          past_surgical_history?: string | null
          patient_id?: string | null
          phone?: string | null
          primary_care_physician?: string | null
          room?: string | null
          rr?: number | null
          snomed_codes?: string[]
          spo2?: number | null
          standardized_output?: Json | null
          status?: string
          temp?: number | null
          unread_labs_alert?: boolean | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          admission_time?: string | null
          age?: number | null
          allergies?: string | null
          assigned_department?: string | null
          author_id?: string | null
          biological_sex?: string
          bp?: string | null
          bp_diastolic?: number | null
          bp_systolic?: number | null
          chief_complaint?: string | null
          code_status?: string | null
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          current_medications?: string | null
          diagnosis?: string | null
          discharge_summary?: string | null
          discharge_time?: string | null
          dob?: string
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          emergency_contact_relationship?: string | null
          environmental_allergies?: string | null
          facility_name?: string
          family_history?: string | null
          first_name?: string | null
          gender?: string
          gender_identity?: string | null
          guarantor?: string | null
          hpi_aggravating_factors?: string | null
          hpi_alleviating_factors?: string | null
          hpi_character?: string | null
          hpi_duration?: string | null
          hpi_location?: string | null
          hpi_onset?: string | null
          hpi_severity?: string | null
          hr?: number | null
          icd10_codes?: string[]
          id?: string
          insurance_policy_number?: string | null
          insurance_provider?: string | null
          last_name?: string | null
          meds_due_count?: number | null
          mrn?: string | null
          name?: string | null
          occupation?: string | null
          past_hospitalizations?: string | null
          past_medical_history?: string | null
          past_surgical_history?: string | null
          patient_id?: string | null
          phone?: string | null
          primary_care_physician?: string | null
          room?: string | null
          rr?: number | null
          snomed_codes?: string[]
          spo2?: number | null
          standardized_output?: Json | null
          status?: string
          temp?: number | null
          unread_labs_alert?: boolean | null
          updated_at?: string
        }
        Relationships: []
      }
      pending_writes: {
        Row: {
          attempts: number
          author_id: string | null
          created_at: string
          id: string
          last_error: string | null
          operation: string
          origin: Database["public"]["Enums"]["provenance_origin"]
          payload: Json
          status: string
          table_name: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          author_id?: string | null
          created_at?: string
          id?: string
          last_error?: string | null
          operation: string
          origin?: Database["public"]["Enums"]["provenance_origin"]
          payload: Json
          status?: string
          table_name: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          author_id?: string | null
          created_at?: string
          id?: string
          last_error?: string | null
          operation?: string
          origin?: Database["public"]["Enums"]["provenance_origin"]
          payload?: Json
          status?: string
          table_name?: string
          updated_at?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          author_id: string | null
          branch: Database["public"]["Enums"]["branch"]
          created_at: string
          created_by_type: Database["public"]["Enums"]["provenance_origin"]
          email: string
          id: string
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          branch: Database["public"]["Enums"]["branch"]
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          email: string
          id: string
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          branch?: Database["public"]["Enums"]["branch"]
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          email?: string
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      provider_notes: {
        Row: {
          author_id: string | null
          author_name: string | null
          author_role: string | null
          content: string
          created_at: string
          created_by_type: Database["public"]["Enums"]["provenance_origin"]
          id: string
          note_type: string
          patient_mrn: string
          signed_at: string | null
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          author_name?: string | null
          author_role?: string | null
          content: string
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          id?: string
          note_type: string
          patient_mrn: string
          signed_at?: string | null
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          author_name?: string | null
          author_role?: string | null
          content?: string
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          id?: string
          note_type?: string
          patient_mrn?: string
          signed_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      role_permissions: {
        Row: {
          author_id: string | null
          created_at: string
          created_by_type: Database["public"]["Enums"]["provenance_origin"]
          facility_name: string
          feature_key: string
          feature_name: string
          id: string
          is_active: boolean | null
          target_role: string
          updated_at: string | null
        }
        Insert: {
          author_id?: string | null
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          facility_name: string
          feature_key: string
          feature_name: string
          id?: string
          is_active?: boolean | null
          target_role: string
          updated_at?: string | null
        }
        Update: {
          author_id?: string | null
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
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
          author_id: string | null
          author_nurse: string | null
          created_at: string | null
          created_by_type: Database["public"]["Enums"]["provenance_origin"]
          esigned_at: string | null
          id: string
          note_text: string
          patient_mrn: string
          sbar_assessment: string | null
          sbar_background: string | null
          sbar_recommendation: string | null
          sbar_situation: string | null
          status: string
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          author_nurse?: string | null
          created_at?: string | null
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          esigned_at?: string | null
          id?: string
          note_text: string
          patient_mrn: string
          sbar_assessment?: string | null
          sbar_background?: string | null
          sbar_recommendation?: string | null
          sbar_situation?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          author_nurse?: string | null
          created_at?: string | null
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          esigned_at?: string | null
          id?: string
          note_text?: string
          patient_mrn?: string
          sbar_assessment?: string | null
          sbar_background?: string | null
          sbar_recommendation?: string | null
          sbar_situation?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      simulation_chief_complaints: {
        Row: {
          complaint_text: string
          id: number
          last_used_at: string | null
        }
        Insert: {
          complaint_text: string
          id?: number
          last_used_at?: string | null
        }
        Update: {
          complaint_text?: string
          id?: number
          last_used_at?: string | null
        }
        Relationships: []
      }
      system_settings: {
        Row: {
          author_id: string | null
          automation_enabled: boolean | null
          created_at: string
          created_by_type: Database["public"]["Enums"]["provenance_origin"]
          id: number
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          automation_enabled?: boolean | null
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          id: number
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          automation_enabled?: boolean | null
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          id?: number
          updated_at?: string
        }
        Relationships: []
      }
      umls_term_cache: {
        Row: {
          author_id: string | null
          codes: Json
          created_at: string
          created_by_type: Database["public"]["Enums"]["provenance_origin"]
          fetched_at: string
          term: string
          updated_at: string
          vocabulary: string
        }
        Insert: {
          author_id?: string | null
          codes: Json
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          fetched_at?: string
          term: string
          updated_at?: string
          vocabulary: string
        }
        Update: {
          author_id?: string | null
          codes?: Json
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          fetched_at?: string
          term?: string
          updated_at?: string
          vocabulary?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          author_id: string | null
          created_at: string
          created_by_type: Database["public"]["Enums"]["provenance_origin"]
          id: string
          role: Database["public"]["Enums"]["app_role"]
          updated_at: string
          user_id: string
        }
        Insert: {
          author_id?: string | null
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          updated_at?: string
          user_id: string
        }
        Update: {
          author_id?: string | null
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      fhir_export_view: {
        Row: {
          fhir_bundle: Json | null
          mrn: string | null
        }
        Relationships: []
      }
      fhir_lab_view: {
        Row: {
          fhir_payload: Json | null
          id: string | null
          mrn: string | null
          patient_uuid: string | null
        }
        Relationships: []
      }
      fhir_medication_view: {
        Row: {
          fhir_payload: Json | null
          id: string | null
          mrn: string | null
          patient_id: string | null
        }
        Insert: {
          fhir_payload?: never
          id?: string | null
          mrn?: string | null
          patient_id?: string | null
        }
        Update: {
          fhir_payload?: never
          id?: string | null
          mrn?: string | null
          patient_id?: string | null
        }
        Relationships: []
      }
      fhir_patient_view: {
        Row: {
          fhir_payload: Json | null
          id: string | null
          mrn: string | null
        }
        Insert: {
          fhir_payload?: never
          id?: string | null
          mrn?: string | null
        }
        Update: {
          fhir_payload?: never
          id?: string | null
          mrn?: string | null
        }
        Relationships: []
      }
      unified_patient_view: {
        Row: {
          mrn: string | null
          unified_bundle: Json | null
        }
        Relationships: []
      }
    }
    Functions: {
      auto_admit_ghost_patient: { Args: never; Returns: undefined }
      auto_discharge_ghost_patients: { Args: never; Returns: undefined }
      auto_order_ghost_labs: { Args: never; Returns: undefined }
      auto_result_ghost_labs: { Args: never; Returns: undefined }
      bytea_to_text: { Args: { data: string }; Returns: string }
      cascade_clinical_automation: { Args: never; Returns: undefined }
      get_fhir_bundle: { Args: { target_mrn: string }; Returns: Json }
      get_next_ghost_complaint: { Args: never; Returns: string }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      http: {
        Args: { request: Database["public"]["CompositeTypes"]["http_request"] }
        Returns: Database["public"]["CompositeTypes"]["http_response"]
        SetofOptions: {
          from: "http_request"
          to: "http_response"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      http_delete:
        | {
            Args: { uri: string }
            Returns: Database["public"]["CompositeTypes"]["http_response"]
            SetofOptions: {
              from: "*"
              to: "http_response"
              isOneToOne: true
              isSetofReturn: false
            }
          }
        | {
            Args: { content: string; content_type: string; uri: string }
            Returns: Database["public"]["CompositeTypes"]["http_response"]
            SetofOptions: {
              from: "*"
              to: "http_response"
              isOneToOne: true
              isSetofReturn: false
            }
          }
      http_get:
        | {
            Args: { uri: string }
            Returns: Database["public"]["CompositeTypes"]["http_response"]
            SetofOptions: {
              from: "*"
              to: "http_response"
              isOneToOne: true
              isSetofReturn: false
            }
          }
        | {
            Args: { data: Json; uri: string }
            Returns: Database["public"]["CompositeTypes"]["http_response"]
            SetofOptions: {
              from: "*"
              to: "http_response"
              isOneToOne: true
              isSetofReturn: false
            }
          }
      http_head: {
        Args: { uri: string }
        Returns: Database["public"]["CompositeTypes"]["http_response"]
        SetofOptions: {
          from: "*"
          to: "http_response"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      http_header: {
        Args: { field: string; value: string }
        Returns: Database["public"]["CompositeTypes"]["http_header"]
        SetofOptions: {
          from: "*"
          to: "http_header"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      http_list_curlopt: {
        Args: never
        Returns: {
          curlopt: string
          value: string
        }[]
      }
      http_patch: {
        Args: { content: string; content_type: string; uri: string }
        Returns: Database["public"]["CompositeTypes"]["http_response"]
        SetofOptions: {
          from: "*"
          to: "http_response"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      http_post:
        | {
            Args: { content: string; content_type: string; uri: string }
            Returns: Database["public"]["CompositeTypes"]["http_response"]
            SetofOptions: {
              from: "*"
              to: "http_response"
              isOneToOne: true
              isSetofReturn: false
            }
          }
        | {
            Args: { data: Json; uri: string }
            Returns: Database["public"]["CompositeTypes"]["http_response"]
            SetofOptions: {
              from: "*"
              to: "http_response"
              isOneToOne: true
              isSetofReturn: false
            }
          }
      http_put: {
        Args: { content: string; content_type: string; uri: string }
        Returns: Database["public"]["CompositeTypes"]["http_response"]
        SetofOptions: {
          from: "*"
          to: "http_response"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      http_reset_curlopt: { Args: never; Returns: boolean }
      http_set_curlopt: {
        Args: { curlopt: string; value: string }
        Returns: boolean
      }
      is_facility_full: { Args: { target_facility: string }; Returns: boolean }
      persist_fhir_resource: {
        Args: {
          _author_id?: string
          _mrn: string
          _origin?: Database["public"]["Enums"]["provenance_origin"]
          _payload: Json
          _resource_id: string
          _resource_type: string
          _source?: string
        }
        Returns: string
      }
      text_to_bytea: { Args: { data: string }; Returns: string }
      urlencode:
        | { Args: { data: Json }; Returns: string }
        | {
            Args: { string: string }
            Returns: {
              error: true
            } & "Could not choose the best candidate function between: public.urlencode(string => bytea), public.urlencode(string => varchar). Try renaming the parameters or the function itself in the database so function overloading can be resolved"
          }
        | {
            Args: { string: string }
            Returns: {
              error: true
            } & "Could not choose the best candidate function between: public.urlencode(string => bytea), public.urlencode(string => varchar). Try renaming the parameters or the function itself in the database so function overloading can be resolved"
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
      provenance_origin: "human" | "automation" | "system" | "unknown"
    }
    CompositeTypes: {
      http_header: {
        field: string | null
        value: string | null
      }
      http_request: {
        method: unknown
        uri: string | null
        headers: Database["public"]["CompositeTypes"]["http_header"][] | null
        content_type: string | null
        content: string | null
      }
      http_response: {
        status: number | null
        content_type: string | null
        headers: Database["public"]["CompositeTypes"]["http_header"][] | null
        content: string | null
      }
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
      provenance_origin: ["human", "automation", "system", "unknown"],
    },
  },
} as const
