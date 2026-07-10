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
          coded_at: string | null
          coding_source: string | null
          created_at: string
          created_by_type: Database["public"]["Enums"]["provenance_origin"]
          id: string
          logged_at: string | null
          mrn: string | null
          reaction: string | null
          reaction_meddra: string | null
          reaction_snomed: string | null
          reaction_umls_cui: string | null
          severity: string | null
          status: string | null
          substance: string
          substance_rxcui: string | null
          substance_snomed: string | null
          substance_umls_cui: string | null
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          coded_at?: string | null
          coding_source?: string | null
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          id?: string
          logged_at?: string | null
          mrn?: string | null
          reaction?: string | null
          reaction_meddra?: string | null
          reaction_snomed?: string | null
          reaction_umls_cui?: string | null
          severity?: string | null
          status?: string | null
          substance: string
          substance_rxcui?: string | null
          substance_snomed?: string | null
          substance_umls_cui?: string | null
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          coded_at?: string | null
          coding_source?: string | null
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          id?: string
          logged_at?: string | null
          mrn?: string | null
          reaction?: string | null
          reaction_meddra?: string | null
          reaction_snomed?: string | null
          reaction_umls_cui?: string | null
          severity?: string | null
          status?: string | null
          substance?: string
          substance_rxcui?: string | null
          substance_snomed?: string | null
          substance_umls_cui?: string | null
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
      allergy_reactions: {
        Row: {
          allergy_id: string
          coded_at: string | null
          coding_source: string | null
          created_at: string
          id: string
          manifestation: string
          meddra_code: string | null
          meddra_display: string | null
          mrn: string
          severity: string | null
          snomed_code: string | null
          snomed_display: string | null
          umls_cui: string | null
          updated_at: string
        }
        Insert: {
          allergy_id: string
          coded_at?: string | null
          coding_source?: string | null
          created_at?: string
          id?: string
          manifestation: string
          meddra_code?: string | null
          meddra_display?: string | null
          mrn: string
          severity?: string | null
          snomed_code?: string | null
          snomed_display?: string | null
          umls_cui?: string | null
          updated_at?: string
        }
        Update: {
          allergy_id?: string
          coded_at?: string | null
          coding_source?: string | null
          created_at?: string
          id?: string
          manifestation?: string
          meddra_code?: string | null
          meddra_display?: string | null
          mrn?: string
          severity?: string | null
          snomed_code?: string | null
          snomed_display?: string | null
          umls_cui?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "allergy_reactions_allergy_id_fkey"
            columns: ["allergy_id"]
            isOneToOne: false
            referencedRelation: "allergies"
            referencedColumns: ["id"]
          },
        ]
      }
      api_health_pings: {
        Row: {
          created_at: string
          error_message: string | null
          id: string
          latency_ms: number | null
          service: string
          status: string
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          id?: string
          latency_ms?: number | null
          service: string
          status: string
        }
        Update: {
          created_at?: string
          error_message?: string | null
          id?: string
          latency_ms?: number | null
          service?: string
          status?: string
        }
        Relationships: []
      }
      auto_api_events: {
        Row: {
          actor: string
          created_at: string
          event_type: string
          facility_name: string | null
          id: string
          mrn: string | null
          payload: Json | null
        }
        Insert: {
          actor?: string
          created_at?: string
          event_type: string
          facility_name?: string | null
          id?: string
          mrn?: string | null
          payload?: Json | null
        }
        Update: {
          actor?: string
          created_at?: string
          event_type?: string
          facility_name?: string | null
          id?: string
          mrn?: string | null
          payload?: Json | null
        }
        Relationships: []
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
      auto_terminologist_log: {
        Row: {
          action: string | null
          codes_count: number | null
          confidence: number | null
          created_at: string
          id: string
          message: string
          run_at: string
          theme: string | null
          value_set_id: string | null
        }
        Insert: {
          action?: string | null
          codes_count?: number | null
          confidence?: number | null
          created_at?: string
          id?: string
          message: string
          run_at?: string
          theme?: string | null
          value_set_id?: string | null
        }
        Update: {
          action?: string | null
          codes_count?: number | null
          confidence?: number | null
          created_at?: string
          id?: string
          message?: string
          run_at?: string
          theme?: string | null
          value_set_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "auto_terminologist_log_value_set_id_fkey"
            columns: ["value_set_id"]
            isOneToOne: false
            referencedRelation: "custom_value_sets"
            referencedColumns: ["id"]
          },
        ]
      }
      automation_watchdog_logs: {
        Row: {
          actions_taken: string | null
          checker_timestamp: string | null
          created_at: string | null
          engine: string | null
          engines_checked: Json
          global_control_status: string | null
          healed_engines: string[] | null
          id: string
          issues_detected: boolean | null
          payload: Json | null
          status: string | null
        }
        Insert: {
          actions_taken?: string | null
          checker_timestamp?: string | null
          created_at?: string | null
          engine?: string | null
          engines_checked: Json
          global_control_status?: string | null
          healed_engines?: string[] | null
          id?: string
          issues_detected?: boolean | null
          payload?: Json | null
          status?: string | null
        }
        Update: {
          actions_taken?: string | null
          checker_timestamp?: string | null
          created_at?: string | null
          engine?: string | null
          engines_checked?: Json
          global_control_status?: string | null
          healed_engines?: string[] | null
          id?: string
          issues_detected?: boolean | null
          payload?: Json | null
          status?: string | null
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
      cds_overrides: {
        Row: {
          alert_type: string
          condition_name: string | null
          condition_snomed: string | null
          created_at: string
          decision: string | null
          drug_name: string | null
          drug_rxnorm: string | null
          facility_name: string | null
          fired_at: string
          id: string
          mrn: string
          patient_name: string | null
          physician_id: string | null
          physician_name: string | null
          reason: string
          risk_score: number | null
          severity: string
        }
        Insert: {
          alert_type: string
          condition_name?: string | null
          condition_snomed?: string | null
          created_at?: string
          decision?: string | null
          drug_name?: string | null
          drug_rxnorm?: string | null
          facility_name?: string | null
          fired_at?: string
          id?: string
          mrn: string
          patient_name?: string | null
          physician_id?: string | null
          physician_name?: string | null
          reason: string
          risk_score?: number | null
          severity: string
        }
        Update: {
          alert_type?: string
          condition_name?: string | null
          condition_snomed?: string | null
          created_at?: string
          decision?: string | null
          drug_name?: string | null
          drug_rxnorm?: string | null
          facility_name?: string | null
          fired_at?: string
          id?: string
          mrn?: string
          patient_name?: string | null
          physician_id?: string | null
          physician_name?: string | null
          reason?: string
          risk_score?: number | null
          severity?: string
        }
        Relationships: []
      }
      cds_suggestions: {
        Row: {
          admission_key: string
          created_at: string | null
          dismissed: boolean | null
          fired_at: string | null
          id: string
          items: Json
          label: string
          mrn: string
          severity: string
          suggestion_id: string
          trigger_code: string | null
          trigger_display: string | null
        }
        Insert: {
          admission_key: string
          created_at?: string | null
          dismissed?: boolean | null
          fired_at?: string | null
          id?: string
          items: Json
          label: string
          mrn: string
          severity: string
          suggestion_id: string
          trigger_code?: string | null
          trigger_display?: string | null
        }
        Update: {
          admission_key?: string
          created_at?: string | null
          dismissed?: boolean | null
          fired_at?: string | null
          id?: string
          items?: Json
          label?: string
          mrn?: string
          severity?: string
          suggestion_id?: string
          trigger_code?: string | null
          trigger_display?: string | null
        }
        Relationships: []
      }
      chv_translations: {
        Row: {
          consumer_term: string
          created_at: string
          id: string
          language: string
          professional_term: string
          reading_level: string | null
          source: string
          source_code: string | null
          umls_cui: string | null
          updated_at: string
          vocabulary: string
        }
        Insert: {
          consumer_term: string
          created_at?: string
          id?: string
          language?: string
          professional_term: string
          reading_level?: string | null
          source?: string
          source_code?: string | null
          umls_cui?: string | null
          updated_at?: string
          vocabulary: string
        }
        Update: {
          consumer_term?: string
          created_at?: string
          id?: string
          language?: string
          professional_term?: string
          reading_level?: string | null
          source?: string
          source_code?: string | null
          umls_cui?: string | null
          updated_at?: string
          vocabulary?: string
        }
        Relationships: []
      }
      clinical_alerts: {
        Row: {
          acknowledged: boolean | null
          acknowledged_at: string | null
          acknowledged_by: string | null
          created_at: string
          detail: Json | null
          id: string
          mrn: string
          severity: string
          type: string
        }
        Insert: {
          acknowledged?: boolean | null
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          created_at?: string
          detail?: Json | null
          id?: string
          mrn: string
          severity: string
          type: string
        }
        Update: {
          acknowledged?: boolean | null
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          created_at?: string
          detail?: Json | null
          id?: string
          mrn?: string
          severity?: string
          type?: string
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
          alert_type: string | null
          allergy_name: string | null
          author_id: string | null
          auto_resolve_at: string | null
          created_at: string
          created_by_type:
            | Database["public"]["Enums"]["provenance_origin"]
            | null
          decided_at: string | null
          decided_by: string | null
          description: string | null
          drug: string | null
          drug_b: string | null
          facility_name: string | null
          family: string | null
          id: string
          kind: string
          medication_order_id: string | null
          mrn: string
          patient_name: string | null
          rationale: string | null
          resolution_rationale: string | null
          resolved_by: string | null
          risk_score: number | null
          rule_id: string | null
          severity: string | null
          status: string
          triggered_by: string | null
          updated_at: string
        }
        Insert: {
          alert_type?: string | null
          allergy_name?: string | null
          author_id?: string | null
          auto_resolve_at?: string | null
          created_at?: string
          created_by_type?:
            | Database["public"]["Enums"]["provenance_origin"]
            | null
          decided_at?: string | null
          decided_by?: string | null
          description?: string | null
          drug?: string | null
          drug_b?: string | null
          facility_name?: string | null
          family?: string | null
          id?: string
          kind: string
          medication_order_id?: string | null
          mrn: string
          patient_name?: string | null
          rationale?: string | null
          resolution_rationale?: string | null
          resolved_by?: string | null
          risk_score?: number | null
          rule_id?: string | null
          severity?: string | null
          status?: string
          triggered_by?: string | null
          updated_at?: string
        }
        Update: {
          alert_type?: string | null
          allergy_name?: string | null
          author_id?: string | null
          auto_resolve_at?: string | null
          created_at?: string
          created_by_type?:
            | Database["public"]["Enums"]["provenance_origin"]
            | null
          decided_at?: string | null
          decided_by?: string | null
          description?: string | null
          drug?: string | null
          drug_b?: string | null
          facility_name?: string | null
          family?: string | null
          id?: string
          kind?: string
          medication_order_id?: string | null
          mrn?: string
          patient_name?: string | null
          rationale?: string | null
          resolution_rationale?: string | null
          resolved_by?: string | null
          risk_score?: number | null
          rule_id?: string | null
          severity?: string | null
          status?: string
          triggered_by?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      conditions: {
        Row: {
          category: string | null
          clinical_status: string | null
          coded_at: string | null
          coding_source: string | null
          created_at: string
          created_by_type: string | null
          display_text: string
          icd10_code: string | null
          icd10_display: string | null
          id: string
          mrn: string
          onset_date: string | null
          patient_name: string | null
          recorded_by: string | null
          snomed_code: string | null
          snomed_display: string | null
          source_section: string | null
          term_status: string | null
          umls_cui: string | null
          updated_at: string
          verification_status: string | null
        }
        Insert: {
          category?: string | null
          clinical_status?: string | null
          coded_at?: string | null
          coding_source?: string | null
          created_at?: string
          created_by_type?: string | null
          display_text: string
          icd10_code?: string | null
          icd10_display?: string | null
          id?: string
          mrn: string
          onset_date?: string | null
          patient_name?: string | null
          recorded_by?: string | null
          snomed_code?: string | null
          snomed_display?: string | null
          source_section?: string | null
          term_status?: string | null
          umls_cui?: string | null
          updated_at?: string
          verification_status?: string | null
        }
        Update: {
          category?: string | null
          clinical_status?: string | null
          coded_at?: string | null
          coding_source?: string | null
          created_at?: string
          created_by_type?: string | null
          display_text?: string
          icd10_code?: string | null
          icd10_display?: string | null
          id?: string
          mrn?: string
          onset_date?: string | null
          patient_name?: string | null
          recorded_by?: string | null
          snomed_code?: string | null
          snomed_display?: string | null
          source_section?: string | null
          term_status?: string | null
          umls_cui?: string | null
          updated_at?: string
          verification_status?: string | null
        }
        Relationships: []
      }
      cross_reactivity_rules: {
        Row: {
          allergy_value_set_id: string | null
          allergy_value_set_name: string | null
          created_at: string
          drug_value_set_id: string | null
          drug_value_set_name: string | null
          family_label: string
          id: string
          notes: string | null
        }
        Insert: {
          allergy_value_set_id?: string | null
          allergy_value_set_name?: string | null
          created_at?: string
          drug_value_set_id?: string | null
          drug_value_set_name?: string | null
          family_label: string
          id?: string
          notes?: string | null
        }
        Update: {
          allergy_value_set_id?: string | null
          allergy_value_set_name?: string | null
          created_at?: string
          drug_value_set_id?: string | null
          drug_value_set_name?: string | null
          family_label?: string
          id?: string
          notes?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cross_reactivity_rules_allergy_value_set_id_fkey"
            columns: ["allergy_value_set_id"]
            isOneToOne: false
            referencedRelation: "custom_value_sets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cross_reactivity_rules_drug_value_set_id_fkey"
            columns: ["drug_value_set_id"]
            isOneToOne: false
            referencedRelation: "custom_value_sets"
            referencedColumns: ["id"]
          },
        ]
      }
      custom_value_sets: {
        Row: {
          author: string | null
          binding_strength: string | null
          change_history: Json | null
          clinical_application: string | null
          codes: Json
          created_at: string
          description: string | null
          fhir_published_at: string | null
          fhir_url: string | null
          id: string
          intensional_rule: Json | null
          name: string
          oid: string | null
          peer_reviewer: string | null
          published_at: string | null
          status: string
          steward: string | null
          system: string
          type: string
          updated_at: string
          version: string | null
          vocabulary: string | null
        }
        Insert: {
          author?: string | null
          binding_strength?: string | null
          change_history?: Json | null
          clinical_application?: string | null
          codes?: Json
          created_at?: string
          description?: string | null
          fhir_published_at?: string | null
          fhir_url?: string | null
          id?: string
          intensional_rule?: Json | null
          name: string
          oid?: string | null
          peer_reviewer?: string | null
          published_at?: string | null
          status?: string
          steward?: string | null
          system: string
          type?: string
          updated_at?: string
          version?: string | null
          vocabulary?: string | null
        }
        Update: {
          author?: string | null
          binding_strength?: string | null
          change_history?: Json | null
          clinical_application?: string | null
          codes?: Json
          created_at?: string
          description?: string | null
          fhir_published_at?: string | null
          fhir_url?: string | null
          id?: string
          intensional_rule?: Json | null
          name?: string
          oid?: string | null
          peer_reviewer?: string | null
          published_at?: string | null
          status?: string
          steward?: string | null
          system?: string
          type?: string
          updated_at?: string
          version?: string | null
          vocabulary?: string | null
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
      drug_interaction_rules: {
        Row: {
          created_at: string
          drug_a_single_code: string | null
          drug_a_single_display: string | null
          drug_a_single_vocabulary: string | null
          drug_a_value_set_id: string | null
          drug_a_value_set_name: string | null
          drug_b_single_code: string | null
          drug_b_single_display: string | null
          drug_b_single_vocabulary: string | null
          drug_b_value_set_id: string | null
          drug_b_value_set_name: string | null
          id: string
          severity: string
          summary: string
        }
        Insert: {
          created_at?: string
          drug_a_single_code?: string | null
          drug_a_single_display?: string | null
          drug_a_single_vocabulary?: string | null
          drug_a_value_set_id?: string | null
          drug_a_value_set_name?: string | null
          drug_b_single_code?: string | null
          drug_b_single_display?: string | null
          drug_b_single_vocabulary?: string | null
          drug_b_value_set_id?: string | null
          drug_b_value_set_name?: string | null
          id?: string
          severity?: string
          summary: string
        }
        Update: {
          created_at?: string
          drug_a_single_code?: string | null
          drug_a_single_display?: string | null
          drug_a_single_vocabulary?: string | null
          drug_a_value_set_id?: string | null
          drug_a_value_set_name?: string | null
          drug_b_single_code?: string | null
          drug_b_single_display?: string | null
          drug_b_single_vocabulary?: string | null
          drug_b_value_set_id?: string | null
          drug_b_value_set_name?: string | null
          id?: string
          severity?: string
          summary?: string
        }
        Relationships: [
          {
            foreignKeyName: "drug_interaction_rules_drug_a_value_set_id_fkey"
            columns: ["drug_a_value_set_id"]
            isOneToOne: false
            referencedRelation: "custom_value_sets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "drug_interaction_rules_drug_b_value_set_id_fkey"
            columns: ["drug_b_value_set_id"]
            isOneToOne: false
            referencedRelation: "custom_value_sets"
            referencedColumns: ["id"]
          },
        ]
      }
      fhir_appointments: {
        Row: {
          comment: string | null
          created_at: string
          description: string | null
          end_time: string
          facility_name: string
          fhir_id: string | null
          id: string
          patient_mrn: string | null
          patient_name: string
          practitioner_name: string | null
          service_type: string | null
          start_time: string
          status: string
          updated_at: string
        }
        Insert: {
          comment?: string | null
          created_at?: string
          description?: string | null
          end_time: string
          facility_name: string
          fhir_id?: string | null
          id?: string
          patient_mrn?: string | null
          patient_name: string
          practitioner_name?: string | null
          service_type?: string | null
          start_time: string
          status?: string
          updated_at?: string
        }
        Update: {
          comment?: string | null
          created_at?: string
          description?: string | null
          end_time?: string
          facility_name?: string
          fhir_id?: string | null
          id?: string
          patient_mrn?: string | null
          patient_name?: string
          practitioner_name?: string | null
          service_type?: string | null
          start_time?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      fhir_charge_items: {
        Row: {
          amount: number
          category: string
          charge_code: string
          code_system: string
          created_at: string
          currency: string
          description: string
          encounter_id: string | null
          id: string
          invoice_id: string
          mrn: string
          payload: Json
          quantity: number
          service_date: string | null
          unit_price: number
        }
        Insert: {
          amount?: number
          category: string
          charge_code: string
          code_system?: string
          created_at?: string
          currency?: string
          description: string
          encounter_id?: string | null
          id?: string
          invoice_id: string
          mrn: string
          payload?: Json
          quantity?: number
          service_date?: string | null
          unit_price?: number
        }
        Update: {
          amount?: number
          category?: string
          charge_code?: string
          code_system?: string
          created_at?: string
          currency?: string
          description?: string
          encounter_id?: string | null
          id?: string
          invoice_id?: string
          mrn?: string
          payload?: Json
          quantity?: number
          service_date?: string | null
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "fhir_charge_items_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "fhir_invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      fhir_communications: {
        Row: {
          created_at: string
          facility_name: string | null
          id: string
          message: string
          mrn: string
          parent_id: string | null
          recipient: string
          resource: Json | null
          sender: string
          sender_label: string | null
          status: string
          subject: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          facility_name?: string | null
          id?: string
          message: string
          mrn: string
          parent_id?: string | null
          recipient: string
          resource?: Json | null
          sender: string
          sender_label?: string | null
          status?: string
          subject?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          facility_name?: string | null
          id?: string
          message?: string
          mrn?: string
          parent_id?: string | null
          recipient?: string
          resource?: Json | null
          sender?: string
          sender_label?: string | null
          status?: string
          subject?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "fhir_communications_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "fhir_communications"
            referencedColumns: ["id"]
          },
        ]
      }
      fhir_invoices: {
        Row: {
          created_at: string
          currency: string
          encounter_id: string | null
          facility_name: string | null
          id: string
          invoice_no: string
          issued_at: string
          mrn: string
          paid_at: string | null
          patient_name: string | null
          payload: Json
          primary_diagnosis_display: string | null
          primary_diagnosis_icd10: string | null
          status: string
          subtotal: number
          tax: number
          total: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          currency?: string
          encounter_id?: string | null
          facility_name?: string | null
          id?: string
          invoice_no: string
          issued_at?: string
          mrn: string
          paid_at?: string | null
          patient_name?: string | null
          payload?: Json
          primary_diagnosis_display?: string | null
          primary_diagnosis_icd10?: string | null
          status?: string
          subtotal?: number
          tax?: number
          total?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          currency?: string
          encounter_id?: string | null
          facility_name?: string | null
          id?: string
          invoice_no?: string
          issued_at?: string
          mrn?: string
          paid_at?: string | null
          patient_name?: string | null
          payload?: Json
          primary_diagnosis_display?: string | null
          primary_diagnosis_icd10?: string | null
          status?: string
          subtotal?: number
          tax?: number
          total?: number
          updated_at?: string
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
      fhir_payment_notices: {
        Row: {
          amount: number
          created_at: string
          currency: string
          fhir_id: string | null
          id: string
          invoice_id: string
          mrn: string
          payload: Json
          payment_date: string
          payment_method: string | null
          status: string
        }
        Insert: {
          amount: number
          created_at?: string
          currency?: string
          fhir_id?: string | null
          id?: string
          invoice_id: string
          mrn: string
          payload?: Json
          payment_date?: string
          payment_method?: string | null
          status?: string
        }
        Update: {
          amount?: number
          created_at?: string
          currency?: string
          fhir_id?: string | null
          id?: string
          invoice_id?: string
          mrn?: string
          payload?: Json
          payment_date?: string
          payment_method?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "fhir_payment_notices_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "fhir_invoices"
            referencedColumns: ["id"]
          },
        ]
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
      fhir_sync_state: {
        Row: {
          key: string
          updated_at: string
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          value?: Json
        }
        Update: {
          key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      formulary_catalog: {
        Row: {
          created_at: string
          dose_form: string | null
          drug_class: string | null
          drug_name: string | null
          full_display: string | null
          id: string
          is_high_alert: boolean
          rxnorm_code: string
          strength: string | null
          synced_at: string
          typical_frequency: string | null
          typical_route: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          dose_form?: string | null
          drug_class?: string | null
          drug_name?: string | null
          full_display?: string | null
          id?: string
          is_high_alert?: boolean
          rxnorm_code: string
          strength?: string | null
          synced_at?: string
          typical_frequency?: string | null
          typical_route?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          dose_form?: string | null
          drug_class?: string | null
          drug_name?: string | null
          full_display?: string | null
          id?: string
          is_high_alert?: boolean
          rxnorm_code?: string
          strength?: string | null
          synced_at?: string
          typical_frequency?: string | null
          typical_route?: string | null
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
          coded_at: string | null
          coding_source: string | null
          collected_at: string | null
          created_at: string | null
          created_by_type: Database["public"]["Enums"]["provenance_origin"]
          facility_name: string
          id: string
          loinc_code: string | null
          loinc_display: string | null
          ordered_by: string | null
          patient_mrn: string
          patient_name: string
          requested_by: string
          result_value: string | null
          resulted_at: string | null
          results_data: Json | null
          source: string
          status: string | null
          svcreq_fhir_id: string | null
          term_status: string | null
          test_type: string
          umls_cui: string | null
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          clinical_condition?: string | null
          coded_at?: string | null
          coding_source?: string | null
          collected_at?: string | null
          created_at?: string | null
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          facility_name: string
          id?: string
          loinc_code?: string | null
          loinc_display?: string | null
          ordered_by?: string | null
          patient_mrn: string
          patient_name: string
          requested_by: string
          result_value?: string | null
          resulted_at?: string | null
          results_data?: Json | null
          source?: string
          status?: string | null
          svcreq_fhir_id?: string | null
          term_status?: string | null
          test_type: string
          umls_cui?: string | null
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          clinical_condition?: string | null
          coded_at?: string | null
          coding_source?: string | null
          collected_at?: string | null
          created_at?: string | null
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          facility_name?: string
          id?: string
          loinc_code?: string | null
          loinc_display?: string | null
          ordered_by?: string | null
          patient_mrn?: string
          patient_name?: string
          requested_by?: string
          result_value?: string | null
          resulted_at?: string | null
          results_data?: Json | null
          source?: string
          status?: string | null
          svcreq_fhir_id?: string | null
          term_status?: string | null
          test_type?: string
          umls_cui?: string | null
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
          loinc_code: string | null
          loinc_display: string | null
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
          loinc_code?: string | null
          loinc_display?: string | null
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
          loinc_code?: string | null
          loinc_display?: string | null
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
          coded_at: string | null
          coding_source: string | null
          created_at: string | null
          created_by_type: Database["public"]["Enums"]["provenance_origin"]
          dispensed_at: string | null
          dose: string | null
          drug: string | null
          drug_name: string | null
          facility_name: string | null
          frequency: string | null
          id: string
          ingredient_rxcui: string | null
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
          rxnorm_code: string | null
          rxnorm_display: string | null
          rxnorm_tty: string | null
          status: string | null
          term_status: string | null
          umls_cui: string | null
          updated_at: string
        }
        Insert: {
          administered_at?: string | null
          approved_at?: string | null
          author_id?: string | null
          coded_at?: string | null
          coding_source?: string | null
          created_at?: string | null
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          dispensed_at?: string | null
          dose?: string | null
          drug?: string | null
          drug_name?: string | null
          facility_name?: string | null
          frequency?: string | null
          id?: string
          ingredient_rxcui?: string | null
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
          rxnorm_code?: string | null
          rxnorm_display?: string | null
          rxnorm_tty?: string | null
          status?: string | null
          term_status?: string | null
          umls_cui?: string | null
          updated_at?: string
        }
        Update: {
          administered_at?: string | null
          approved_at?: string | null
          author_id?: string | null
          coded_at?: string | null
          coding_source?: string | null
          created_at?: string | null
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          dispensed_at?: string | null
          dose?: string | null
          drug?: string | null
          drug_name?: string | null
          facility_name?: string | null
          frequency?: string | null
          id?: string
          ingredient_rxcui?: string | null
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
          rxnorm_code?: string | null
          rxnorm_display?: string | null
          rxnorm_tty?: string | null
          status?: string | null
          term_status?: string | null
          umls_cui?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      medication_requests: {
        Row: {
          created_at: string
          display_name: string
          dosage: string | null
          frequency: string | null
          id: string
          intent: string
          ordered_at: string
          patient_id: string
          patient_mrn: string | null
          requester: string | null
          route: string | null
          rxnorm_code: string | null
          source: string | null
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_name: string
          dosage?: string | null
          frequency?: string | null
          id?: string
          intent?: string
          ordered_at?: string
          patient_id: string
          patient_mrn?: string | null
          requester?: string | null
          route?: string | null
          rxnorm_code?: string | null
          source?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_name?: string
          dosage?: string | null
          frequency?: string | null
          id?: string
          intent?: string
          ordered_at?: string
          patient_id?: string
          patient_mrn?: string | null
          requester?: string | null
          route?: string | null
          rxnorm_code?: string | null
          source?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "medication_requests_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "fhir_lab_view"
            referencedColumns: ["patient_uuid"]
          },
          {
            foreignKeyName: "medication_requests_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "fhir_patient_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medication_requests_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
        ]
      }
      nlp_audit_logs: {
        Row: {
          approved_by: string | null
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
          approved_by?: string | null
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
          approved_by?: string | null
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
      nlp_qa_queue: {
        Row: {
          complaint_snippet: string | null
          confidence: number
          created_at: string
          facility_name: string | null
          id: string
          mrn: string
          patient_name: string | null
          proposed_codes: Json
          reviewed_at: string | null
          reviewer: string | null
          sla_expires_at: string
          source_audit_id: string | null
          status: string
          updated_at: string
        }
        Insert: {
          complaint_snippet?: string | null
          confidence: number
          created_at?: string
          facility_name?: string | null
          id?: string
          mrn: string
          patient_name?: string | null
          proposed_codes?: Json
          reviewed_at?: string | null
          reviewer?: string | null
          sla_expires_at?: string
          source_audit_id?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          complaint_snippet?: string | null
          confidence?: number
          created_at?: string
          facility_name?: string | null
          id?: string
          mrn?: string
          patient_name?: string | null
          proposed_codes?: Json
          reviewed_at?: string | null
          reviewer?: string | null
          sla_expires_at?: string
          source_audit_id?: string | null
          status?: string
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
      observations: {
        Row: {
          abnormal_flag: string | null
          created_at: string
          display_name: string
          id: string
          loinc_code: string | null
          patient_id: string
          patient_mrn: string | null
          recorded_at: string
          reference_range: string | null
          source: string | null
          status: string
          unit: string | null
          updated_at: string
          value: string | null
          value_numeric: number | null
        }
        Insert: {
          abnormal_flag?: string | null
          created_at?: string
          display_name: string
          id?: string
          loinc_code?: string | null
          patient_id: string
          patient_mrn?: string | null
          recorded_at?: string
          reference_range?: string | null
          source?: string | null
          status?: string
          unit?: string | null
          updated_at?: string
          value?: string | null
          value_numeric?: number | null
        }
        Update: {
          abnormal_flag?: string | null
          created_at?: string
          display_name?: string
          id?: string
          loinc_code?: string | null
          patient_id?: string
          patient_mrn?: string | null
          recorded_at?: string
          reference_range?: string | null
          source?: string | null
          status?: string
          unit?: string | null
          updated_at?: string
          value?: string | null
          value_numeric?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "observations_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "fhir_lab_view"
            referencedColumns: ["patient_uuid"]
          },
          {
            foreignKeyName: "observations_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "fhir_patient_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "observations_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
        ]
      }
      patient_assignments: {
        Row: {
          assigned_at: string
          facility: string | null
          id: string
          mrn: string
          nurse_id: string | null
          nurse_name: string | null
          physician_id: string | null
          physician_name: string | null
          released_at: string | null
        }
        Insert: {
          assigned_at?: string
          facility?: string | null
          id?: string
          mrn: string
          nurse_id?: string | null
          nurse_name?: string | null
          physician_id?: string | null
          physician_name?: string | null
          released_at?: string | null
        }
        Update: {
          assigned_at?: string
          facility?: string | null
          id?: string
          mrn?: string
          nurse_id?: string | null
          nurse_name?: string | null
          physician_id?: string | null
          physician_name?: string | null
          released_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "patient_assignments_nurse_id_fkey"
            columns: ["nurse_id"]
            isOneToOne: false
            referencedRelation: "staff_roster"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_assignments_physician_id_fkey"
            columns: ["physician_id"]
            isOneToOne: false
            referencedRelation: "staff_roster"
            referencedColumns: ["id"]
          },
        ]
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
          discharge_summary_generated: boolean | null
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
          last_fhir_sync: string | null
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
          target_discharge_at: string | null
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
          discharge_summary_generated?: boolean | null
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
          last_fhir_sync?: string | null
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
          target_discharge_at?: string | null
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
          discharge_summary_generated?: boolean | null
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
          last_fhir_sync?: string | null
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
          target_discharge_at?: string | null
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
      procedures: {
        Row: {
          coded_at: string | null
          coding_source: string | null
          cpt_code: string | null
          cpt_display: string | null
          created_at: string
          created_by_type: string | null
          display_text: string
          icd10pcs_code: string | null
          id: string
          mrn: string
          patient_name: string | null
          performed_at: string | null
          performed_by: string | null
          snomed_code: string | null
          snomed_display: string | null
          status: string | null
          umls_cui: string | null
          updated_at: string
        }
        Insert: {
          coded_at?: string | null
          coding_source?: string | null
          cpt_code?: string | null
          cpt_display?: string | null
          created_at?: string
          created_by_type?: string | null
          display_text: string
          icd10pcs_code?: string | null
          id?: string
          mrn: string
          patient_name?: string | null
          performed_at?: string | null
          performed_by?: string | null
          snomed_code?: string | null
          snomed_display?: string | null
          status?: string | null
          umls_cui?: string | null
          updated_at?: string
        }
        Update: {
          coded_at?: string | null
          coding_source?: string | null
          cpt_code?: string | null
          cpt_display?: string | null
          created_at?: string
          created_by_type?: string | null
          display_text?: string
          icd10pcs_code?: string | null
          id?: string
          mrn?: string
          patient_name?: string | null
          performed_at?: string | null
          performed_by?: string | null
          snomed_code?: string | null
          snomed_display?: string | null
          status?: string | null
          umls_cui?: string | null
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
      radiology_orders: {
        Row: {
          body_part: string | null
          clinical_indication: string | null
          created_at: string
          created_by_type: Database["public"]["Enums"]["provenance_origin"]
          exam_type: string
          facility_name: string | null
          id: string
          image_url: string | null
          impression: string | null
          modality: string | null
          ordered_at: string
          patient_mrn: string
          patient_name: string | null
          report_text: string | null
          requested_by: string | null
          resulted_at: string | null
          snomed_code: string | null
          snomed_display: string | null
          source: string
          status: string
          svcreq_fhir_id: string | null
          updated_at: string
        }
        Insert: {
          body_part?: string | null
          clinical_indication?: string | null
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          exam_type: string
          facility_name?: string | null
          id?: string
          image_url?: string | null
          impression?: string | null
          modality?: string | null
          ordered_at?: string
          patient_mrn: string
          patient_name?: string | null
          report_text?: string | null
          requested_by?: string | null
          resulted_at?: string | null
          snomed_code?: string | null
          snomed_display?: string | null
          source?: string
          status?: string
          svcreq_fhir_id?: string | null
          updated_at?: string
        }
        Update: {
          body_part?: string | null
          clinical_indication?: string | null
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          exam_type?: string
          facility_name?: string | null
          id?: string
          image_url?: string | null
          impression?: string | null
          modality?: string | null
          ordered_at?: string
          patient_mrn?: string
          patient_name?: string | null
          report_text?: string | null
          requested_by?: string | null
          resulted_at?: string | null
          snomed_code?: string | null
          snomed_display?: string | null
          source?: string
          status?: string
          svcreq_fhir_id?: string | null
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
      safety_alerts: {
        Row: {
          alert_type: string
          allergy_rxcui: string | null
          allergy_substance: string | null
          created_at: string
          detail: Json | null
          drug_name: string | null
          drug_rxcui: string | null
          id: string
          mrn: string
          resolved_at: string | null
          severity: string
          status: string
        }
        Insert: {
          alert_type: string
          allergy_rxcui?: string | null
          allergy_substance?: string | null
          created_at?: string
          detail?: Json | null
          drug_name?: string | null
          drug_rxcui?: string | null
          id?: string
          mrn: string
          resolved_at?: string | null
          severity?: string
          status?: string
        }
        Update: {
          alert_type?: string
          allergy_rxcui?: string | null
          allergy_substance?: string | null
          created_at?: string
          detail?: Json | null
          drug_name?: string | null
          drug_rxcui?: string | null
          id?: string
          mrn?: string
          resolved_at?: string | null
          severity?: string
          status?: string
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
      staff_roster: {
        Row: {
          active: boolean
          assigned_patient_count: number
          created_at: string
          facility: string
          id: string
          name: string
          role: string
          shift_end: string | null
          shift_start: string | null
        }
        Insert: {
          active?: boolean
          assigned_patient_count?: number
          created_at?: string
          facility: string
          id?: string
          name: string
          role: string
          shift_end?: string | null
          shift_start?: string | null
        }
        Update: {
          active?: boolean
          assigned_patient_count?: number
          created_at?: string
          facility?: string
          id?: string
          name?: string
          role?: string
          shift_end?: string | null
          shift_start?: string | null
        }
        Relationships: []
      }
      system_settings: {
        Row: {
          author_id: string | null
          auto_admin_enabled: boolean
          auto_api_enabled: boolean
          auto_doc_enabled: boolean
          auto_it_enabled: boolean
          automation_enabled: boolean | null
          created_at: string
          created_by_type: Database["public"]["Enums"]["provenance_origin"]
          ghost_safety_demo_counter: number
          id: number
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          auto_admin_enabled?: boolean
          auto_api_enabled?: boolean
          auto_doc_enabled?: boolean
          auto_it_enabled?: boolean
          automation_enabled?: boolean | null
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          ghost_safety_demo_counter?: number
          id: number
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          auto_admin_enabled?: boolean
          auto_api_enabled?: boolean
          auto_doc_enabled?: boolean
          auto_it_enabled?: boolean
          automation_enabled?: boolean | null
          created_at?: string
          created_by_type?: Database["public"]["Enums"]["provenance_origin"]
          ghost_safety_demo_counter?: number
          id?: number
          updated_at?: string
        }
        Relationships: []
      }
      terminology_activity_log: {
        Row: {
          action: string
          actor: string
          created_at: string
          feature: string
          id: string
          message: string
          metadata: Json | null
          ref_id: string | null
        }
        Insert: {
          action: string
          actor: string
          created_at?: string
          feature: string
          id?: string
          message: string
          metadata?: Json | null
          ref_id?: string | null
        }
        Update: {
          action?: string
          actor?: string
          created_at?: string
          feature?: string
          id?: string
          message?: string
          metadata?: Json | null
          ref_id?: string | null
        }
        Relationships: []
      }
      terminology_audit: {
        Row: {
          action: string
          cache_hit: boolean | null
          confidence: number | null
          created_at: string
          elapsed_ms: number | null
          id: string
          input_text: string
          mrn: string | null
          raw_response: Json | null
          resolved_code: string | null
          resolved_display: string | null
          resolver: string | null
          resource_id: string | null
          resource_type: string
          umls_cui: string | null
          vocabulary: string
        }
        Insert: {
          action: string
          cache_hit?: boolean | null
          confidence?: number | null
          created_at?: string
          elapsed_ms?: number | null
          id?: string
          input_text: string
          mrn?: string | null
          raw_response?: Json | null
          resolved_code?: string | null
          resolved_display?: string | null
          resolver?: string | null
          resource_id?: string | null
          resource_type: string
          umls_cui?: string | null
          vocabulary: string
        }
        Update: {
          action?: string
          cache_hit?: boolean | null
          confidence?: number | null
          created_at?: string
          elapsed_ms?: number | null
          id?: string
          input_text?: string
          mrn?: string | null
          raw_response?: Json | null
          resolved_code?: string | null
          resolved_display?: string | null
          resolver?: string | null
          resource_id?: string | null
          resource_type?: string
          umls_cui?: string | null
          vocabulary?: string
        }
        Relationships: []
      }
      terminology_requests: {
        Row: {
          clinical_application: string | null
          id: string
          justification: string
          priority: string
          quality_gate_notes: string | null
          related_mrn: string | null
          requested_at: string
          requested_name: string
          requesting_consumer: string
          resolved_at: string | null
          seed_codes: Json
          status: string
          updated_at: string
          value_set_id: string | null
          vocabulary: string | null
        }
        Insert: {
          clinical_application?: string | null
          id?: string
          justification: string
          priority?: string
          quality_gate_notes?: string | null
          related_mrn?: string | null
          requested_at?: string
          requested_name: string
          requesting_consumer: string
          resolved_at?: string | null
          seed_codes?: Json
          status?: string
          updated_at?: string
          value_set_id?: string | null
          vocabulary?: string | null
        }
        Update: {
          clinical_application?: string | null
          id?: string
          justification?: string
          priority?: string
          quality_gate_notes?: string | null
          related_mrn?: string | null
          requested_at?: string
          requested_name?: string
          requesting_consumer?: string
          resolved_at?: string | null
          seed_codes?: Json
          status?: string
          updated_at?: string
          value_set_id?: string | null
          vocabulary?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "terminology_requests_value_set_id_fkey"
            columns: ["value_set_id"]
            isOneToOne: false
            referencedRelation: "custom_value_sets"
            referencedColumns: ["id"]
          },
        ]
      }
      umls_cache: {
        Row: {
          cache_key: string
          cached_at: string
          expires_at: string
          response: Json
          vocabulary: string
        }
        Insert: {
          cache_key: string
          cached_at?: string
          expires_at?: string
          response: Json
          vocabulary: string
        }
        Update: {
          cache_key?: string
          cached_at?: string
          expires_at?: string
          response?: Json
          vocabulary?: string
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
      value_set_dependencies: {
        Row: {
          consumer: string
          consumer_file: string | null
          created_at: string
          id: string
          lookup_mode: string
          notes: string | null
          purpose: string
          required: boolean
          updated_at: string
          value_set_id: string | null
          value_set_name: string
        }
        Insert: {
          consumer: string
          consumer_file?: string | null
          created_at?: string
          id?: string
          lookup_mode?: string
          notes?: string | null
          purpose: string
          required?: boolean
          updated_at?: string
          value_set_id?: string | null
          value_set_name: string
        }
        Update: {
          consumer?: string
          consumer_file?: string | null
          created_at?: string
          id?: string
          lookup_mode?: string
          notes?: string | null
          purpose?: string
          required?: boolean
          updated_at?: string
          value_set_id?: string | null
          value_set_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "value_set_dependencies_value_set_id_fkey"
            columns: ["value_set_id"]
            isOneToOne: false
            referencedRelation: "custom_value_sets"
            referencedColumns: ["id"]
          },
        ]
      }
      vitals: {
        Row: {
          bp_diastolic: number | null
          bp_systolic: number | null
          hr: number | null
          id: string
          loinc_code: string | null
          loinc_display: string | null
          loinc_map: Json | null
          mrn: string
          recorded_at: string
          rr: number | null
          source: string | null
          spo2: number | null
          temp_c: number | null
        }
        Insert: {
          bp_diastolic?: number | null
          bp_systolic?: number | null
          hr?: number | null
          id?: string
          loinc_code?: string | null
          loinc_display?: string | null
          loinc_map?: Json | null
          mrn: string
          recorded_at?: string
          rr?: number | null
          source?: string | null
          spo2?: number | null
          temp_c?: number | null
        }
        Update: {
          bp_diastolic?: number | null
          bp_systolic?: number | null
          hr?: number | null
          id?: string
          loinc_code?: string | null
          loinc_display?: string | null
          loinc_map?: Json | null
          mrn?: string
          recorded_at?: string
          rr?: number | null
          source?: string | null
          spo2?: number | null
          temp_c?: number | null
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
      _ghost_insert_med_from_class: {
        Args: {
          p_classes: string[]
          p_facility: string
          p_fallback_dose: string
          p_fallback_freq: string
          p_fallback_name: string
          p_fallback_route: string
          p_fallback_rxnorm: string
          p_mrn: string
          p_ordering_doc: string
          p_patient_name: string
        }
        Returns: undefined
      }
      auto_admit_ghost_patient: { Args: never; Returns: undefined }
      auto_code_patient_complaint: {
        Args: { _complaint: string; _mrn: string; _name: string }
        Returns: undefined
      }
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
      purge_expired_local_cache: { Args: never; Returns: Json }
      resolve_simulated_lab_result: {
        Args: { p_test_type: string }
        Returns: {
          analyte: string
          flag: string
          loinc_code: string
          loinc_display: string
          reference_range: string
          unit: string
          value_num: number
        }[]
      }
      sweep_stalled_clinical_orders: { Args: never; Returns: undefined }
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
