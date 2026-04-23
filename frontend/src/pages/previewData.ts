// Auto-generated from full-export JSON -- real agent workflow data
// Contains 80 nodes and 128 edges

export const REAL_WORKFLOW_NODES = [
  {
    "id": "bgUbMDsuDRR5uHi5WYYLO",
    "type": "start",
    "label": "Start Node",
    "position": {
      "x": -8152.777276872494,
      "y": 680.3290966789881
    },
    "message": "# Role\nYou are Nora, Al Salamah Hospital's virtual assistant. This is the greeting node.\n\n# Instruct",
    "transitions": [
      {
        "condition": {
          "description": "When the user wants to book an appointment in anyway without mentioning the department name or doctor name, mentioning IDs, numbers, doctors, or clinics "
        }
      },
      {
        "condition": {
          "description": "When mentioning to cancel an appointment in anyway without mentioning IDs, doctors, or clinics"
        }
      },
      {
        "condition": {
          "description": "When mentioning to reschedule or change an appointment in anyway without mentioning IDs, numbers, doctors, or clinics"
        }
      },
      {
        "condition": {
          "description": "When the user say they have pain or complain about pain in anyway without mentioning IDs, numbers, doctors, or clinics"
        }
      },
      {
        "condition": {
          "description": "When the user mentions a doctor name without mentioning IDs, numbers, doctors, or clinics"
        }
      },
      {
        "condition": {
          "description": "When the user wants to know the appointment they have in anyway without mentioning IDs, numbers, doctors, or clinics"
        }
      },
      {
        "condition": {
          "description": "When the user mention that they have booked an appointment but they need to know the details in anyway without mentioning IDs, numbers, doctors, or clinics"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "language_code"
        },
        {
          "name": "intention"
        },
        {
          "name": "doctor_name"
        }
      ]
    }
  },
  {
    "id": "YDMXOjdIOcIH92kDtk4Ey",
    "type": "conversation",
    "label": "",
    "position": {
      "x": -3083.13841047249,
      "y": -164.9542549960385
    },
    "message": "{%- if available_appointments and available_appointments | length > 0 %}\nAvailable appointments:\n{%-",
    "transitions": [
      {
        "condition": {
          "description": "when the user picks a time slot in anyway without providing their number or ID"
        }
      },
      {
        "condition": {
          "description": "When the user chooses the appointment date or time in anyway without providing their number or ID"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "new_appointment_id"
        },
        {
          "name": "appointment_date_time"
        }
      ]
    }
  },
  {
    "id": "GhD_GaH9HWllK7-HHDqhP",
    "type": "conversation",
    "label": "",
    "position": {
      "x": -2303.779549116928,
      "y": -314.9322592427928
    },
    "message": "ask user exactly:\nأحتاج فضلاً  اعرف هل الملف على\n رقم الجوال  او  على رقم الهوية الوطنية او الاقامة ",
    "transitions": [
      {
        "condition": {
          "description": "when user provides phone number or id number"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "id_type"
        },
        {
          "name": "id_value"
        }
      ]
    }
  },
  {
    "id": "LK472OyeDGcBUOTgRH7j_",
    "type": "conversation",
    "label": "",
    "position": {
      "x": -2327.723854594341,
      "y": 212.055495182121
    },
    "message": "ask user exactly:\nتمام أستاذي/تي، لحظات من فضلك رح\nاحتاج منك بعض المعلومات عشان افتح لك الملف؟\nتشرفن",
    "transitions": [
      {
        "condition": {
          "description": "when user provides their name "
        }
      },
      {
        "condition": {
          "description": "When the user confirms their name"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "first_name_ar"
        },
        {
          "name": "second_name_ar"
        },
        {
          "name": "third_name_ar"
        },
        {
          "name": "last_name_ar"
        },
        {
          "name": "first_name_en"
        },
        {
          "name": "second_name_en"
        },
        {
          "name": "third_name_en"
        },
        {
          "name": "last_name_en"
        }
      ]
    }
  },
  {
    "id": "Xd_NDZuaqNfclntcn7hsq",
    "type": "tool",
    "label": "last Search Patient",
    "position": {
      "x": -1870.670058094902,
      "y": -257.0973351456297
    },
    "transitions": [
      {
        "condition": {
          "description": "When the tool completes successfully"
        }
      },
      {
        "condition": {
          "description": "When the tool fails to execute"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "message"
        },
        {
          "name": "patient_id"
        }
      ]
    }
  },
  {
    "id": "2PWmvqOTPXr2mXvEzIG7f",
    "type": "conversation",
    "label": "",
    "position": {
      "x": 272.7146117360377,
      "y": -215.0290600542871
    },
    "message": "تمام أستاذي/تي، تم حجز الموعد مع الدكتور {{ physician_name }} في عيادة {{ speciality_name }} يوم {{ ",
    "transitions": [
      {
        "condition": {
          "description": "when user says no, Thank you "
        }
      },
      {
        "condition": {
          "description": "When the user show gratitude in any way or say they don't need help"
        }
      }
    ]
  },
  {
    "id": "4v_-WdOGcSHh7eB3Gnrv1",
    "type": "end_call",
    "label": "",
    "position": {
      "x": 703.3950856306335,
      "y": -313.2467105451456
    },
    "message": "شكرا لاختيارك مستشفى السلامة. في أمان لله. معاك\nالتقييم.\nThank you for choosing Alsalama\nHospital, w"
  },
  {
    "id": "IvXZoJJuixEoaVoU4cMBm",
    "type": "conversation",
    "label": "",
    "position": {
      "x": -1412.275176038975,
      "y": 326.7067793244251
    },
    "message": "ask user exactly:\nتاريخ الميلاد هجري أو ميلادي\nYour date of birth, please?",
    "transitions": [
      {
        "condition": {
          "description": "when user provides their date of birth "
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "dob"
        }
      ]
    }
  },
  {
    "id": "HYHcV_n36IBV4N597WJNv",
    "type": "conversation",
    "label": "",
    "position": {
      "x": -982.8919637827876,
      "y": 441.5815164955013
    },
    "message": "ask user exactly:\nرقم الجوال اللي حاب تسجله في الملف؟ على\nنفس الرقم أم رقم آخر؟\nWhich mobile number ",
    "transitions": [
      {
        "condition": {
          "description": "when user provides their phone number or say its the same phone number "
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "mobile_num"
        }
      ]
    }
  },
  {
    "id": "qT57Ura7ITUMXgsz4SQML",
    "type": "conversation",
    "label": "",
    "position": {
      "x": -580.9329467859766,
      "y": 436.9118088044294
    },
    "message": "ask user exactly:\nالحالة الاجتماعية فضلا\nyour marital status?\n\nsingle / married?",
    "transitions": [
      {
        "condition": {
          "description": "when user says their martial status (single, married)"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "marital_status"
        }
      ]
    }
  },
  {
    "id": "25Ox6Gto5O0Vj9vq8C4Y1",
    "type": "conversation",
    "label": "",
    "position": {
      "x": -155.9772531737212,
      "y": 431.3053308722268
    },
    "message": "ask user exactly:\nالجنسية من فضلك\nyour Nationality, please?",
    "transitions": [
      {
        "condition": {
          "description": "when user mention their nationality "
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "nationality"
        }
      ]
    }
  },
  {
    "id": "rtzXHd9oAUJCnq3lIMYtZ",
    "type": "conversation",
    "label": "",
    "position": {
      "x": -1842.085766256611,
      "y": 307.1381169940177
    },
    "message": "ask user exactly:\nرقم الهوية فضلا\nmay I have your ID number,\nplease?\n\nWhen the user gives their ID o",
    "transitions": [
      {
        "condition": {
          "description": "when user provides their id number"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "id_value"
        }
      ]
    }
  },
  {
    "id": "0tTHX_gc3J6nXEVg5uc2R",
    "type": "conversation",
    "label": "",
    "position": {
      "x": 336.918714534048,
      "y": 456.7706393912515
    },
    "message": "say the below exactly:\n\nلحظات من فضلك رح اتأكد لك انه التأمين مغطى\na moment please, let me check\nyou",
    "transitions": [
      {
        "condition": {
          "description": "Auto-advance"
        }
      }
    ]
  },
  {
    "id": "in6pdDMfyI7OQW-hCfrHD",
    "type": "conversation",
    "label": "",
    "position": {
      "x": 836.9516956673383,
      "y": 454.431180639437
    },
    "message": "say the below exactly:\n\nYour insurance is covered ,  we've opened a new file for you.\nتمام أستاذي ال",
    "transitions": [
      {
        "condition": {
          "description": "Auto-advance"
        }
      }
    ]
  },
  {
    "id": "aptpXj4Q7jf5Fwa315rmW",
    "type": "tool",
    "label": "last Create Patient Record",
    "position": {
      "x": 1234.720049695139,
      "y": 429.845873957291
    },
    "transitions": [
      {
        "condition": {
          "description": "When the tool completes successfully"
        }
      },
      {
        "condition": {
          "description": "When the tool fails to execute"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "patient_id"
        },
        {
          "name": "message"
        }
      ]
    }
  },
  {
    "id": "oeaHIh_c4Ha71vmy0N0_K",
    "type": "conversation",
    "label": "",
    "position": {
      "x": -6969.303018709153,
      "y": 1711.351723362029
    },
    "message": "Ask the following question exactly once and do not repeat it unless the user’s response is unclear o",
    "transitions": [
      {
        "condition": {
          "description": "when user says yes on the same phone number or   National ID or Iqama,  or on Medical Record Number or gives the number "
        }
      },
      {
        "condition": {
          "description": "when user says on another phone number"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "id_type"
        },
        {
          "name": "id_value"
        }
      ]
    }
  },
  {
    "id": "PD3ihB75qZWR5NNP78Onz",
    "type": "conversation",
    "label": "",
    "position": {
      "x": -5360.340339240199,
      "y": 1557.618085109606
    },
    "message": "ask user exactly:\nالموعد باسم مين فضلا\n? Whose name is the appointment",
    "transitions": [
      {
        "condition": {
          "description": "when user provides the name "
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "patient_name"
        }
      ]
    }
  },
  {
    "id": "O7VPR24xqKDncFbi9ciPU",
    "type": "conversation",
    "label": "",
    "position": {
      "x": -5965.276621613539,
      "y": 2084.480570819026
    },
    "message": "ask user exactly:\nتزودني برقم الجوال الاخر لو سمحت \n\nonly accept the phone  number in this format: 0",
    "transitions": [
      {
        "condition": {
          "description": "when user provides their phone number"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "another_phone_num"
        }
      ]
    }
  },
  {
    "id": "vQ7DXP_gvH62TXFya-XbO",
    "type": "tool",
    "label": "last Get Booked Appointments",
    "position": {
      "x": -1119.043172192079,
      "y": 1598.901252796274
    },
    "transitions": [
      {
        "condition": {
          "description": "When the tool completes successfully"
        }
      },
      {
        "condition": {
          "description": "When the tool fails to execute"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "message"
        },
        {
          "name": "physician_name"
        },
        {
          "name": "specialty_name"
        },
        {
          "name": "start_date_time"
        },
        {
          "name": "appointments"
        },
        {
          "name": "patient_id"
        }
      ]
    }
  },
  {
    "id": "AqeuHq-_0yILckazKZxiX",
    "type": "conversation",
    "label": "",
    "position": {
      "x": 2514.697803782032,
      "y": 1738.900581968212
    },
    "message": "say the below exactly:\nتم الغاء الموعد أستاذي ورح توصلك رسالة بتأكيد\nالالغاء, هل فيه أي خدمة أخرى أق",
    "transitions": [
      {
        "condition": {
          "description": "when user says no, thank you"
        }
      },
      {
        "condition": {
          "description": "When the user show gratitude in any way or say they don't need help"
        }
      }
    ]
  },
  {
    "id": "BtmGvfS-yEytMKctb5jz0",
    "type": "end_call",
    "label": "",
    "position": {
      "x": 5126.349520600583,
      "y": 3738.318344047384
    },
    "message": "شكرا لاختيارك مستشفى السلامة. في أمان الله. معاك\nالتقييم.\nThank you for choosing Alsalama\nHospital, "
  },
  {
    "id": "uC3w0YluqoEXMIQQ9Q00u",
    "type": "tool",
    "label": "last Cancel Appointment",
    "position": {
      "x": 1329.689294972654,
      "y": 1772.154903078914
    },
    "transitions": [
      {
        "condition": {
          "description": "When the tool completes successfully"
        }
      },
      {
        "condition": {
          "description": "When the tool fails to execute"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "message3"
        }
      ]
    }
  },
  {
    "id": "kOOrWZfgSoBpMIU8-_lor",
    "type": "conversation",
    "label": "",
    "position": {
      "x": 319.4601412566581,
      "y": 2155.387187310464
    },
    "message": "say the below exactly:\nالمعذرة ما لقيت لك موعد مسجل ",
    "transitions": [
      {
        "condition": {
          "description": "Auto-advance"
        }
      }
    ]
  },
  {
    "id": "YYsR_hgqdyBNyQSAUQwva",
    "type": "tool",
    "label": "last Get Physicians",
    "position": {
      "x": -4630.673974735283,
      "y": -126.5841712441213
    },
    "transitions": [
      {
        "condition": {
          "description": "When the tool completes successfully"
        }
      },
      {
        "condition": {
          "description": "When the tool fails to execute"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "physicians"
        }
      ]
    }
  },
  {
    "id": "4HqTkjaMDrTCVZf26ntTV",
    "type": "tool",
    "label": "last Get Specialties",
    "position": {
      "x": -5514.180250378094,
      "y": -84.9118081527603
    },
    "transitions": [
      {
        "condition": {
          "description": "When the tool completes successfully"
        }
      },
      {
        "condition": {
          "description": "When the tool fails to execute"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "specialities"
        }
      ]
    }
  },
  {
    "id": "4ujek527tG2zR9tj6ZlfX",
    "type": "tool",
    "label": "last Get Available Appointments",
    "position": {
      "x": -3843.399650508321,
      "y": -118.1191646083793
    },
    "transitions": [
      {
        "condition": {
          "description": "When the tool completes successfully"
        }
      },
      {
        "condition": {
          "description": "When the tool fails to execute"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "available_appointments"
        },
        {
          "name": "message"
        }
      ]
    }
  },
  {
    "id": "jym_qkZxHT08ezfVfz9AB",
    "type": "router",
    "label": "",
    "position": {
      "x": -568.1151270419758,
      "y": 1897.218950430848
    },
    "transitions": [
      {
        "condition": {
          "description": "Default fallback when no other conditions match"
        }
      },
      {
        "condition": {
          "description": "ALL conditions must be met"
        }
      },
      {
        "condition": {
          "description": "ALL conditions must be met"
        }
      }
    ]
  },
  {
    "id": "qCHH_yDYmAyD9BQyrGlll",
    "type": "tool",
    "label": "last Search Patient",
    "position": {
      "x": -4661.367392736638,
      "y": 1733.43237109623
    },
    "transitions": [
      {
        "condition": {
          "description": "When the tool completes successfully"
        }
      },
      {
        "condition": {
          "description": "When the tool fails to execute"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "patient_id"
        },
        {
          "name": "message2"
        }
      ]
    }
  },
  {
    "id": "o95EhUGtU205oArqOVQaX",
    "type": "conversation",
    "label": "",
    "position": {
      "x": 742.0946160956948,
      "y": 1473.455128996803
    },
    "message": "{% for appointment in appointments %}\nهل تود الغاء الموعد؟ عندك موعد مع الدكتور {{ appointment.physi",
    "transitions": [
      {
        "condition": {
          "description": "when user confirms the appointment they want to cancel  "
        }
      },
      {
        "condition": {
          "description": "when user choose any appointment would like to cancel"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "canceled_appointment"
        }
      ]
    }
  },
  {
    "id": "vi_2bJz5byjhl9xQtm2MI",
    "type": "tool",
    "label": "last Get Booked Appointments",
    "position": {
      "x": -2583.46384160666,
      "y": 2149.45913512805
    },
    "transitions": [
      {
        "condition": {
          "description": "When the tool completes successfully"
        }
      },
      {
        "condition": {
          "description": "When the tool fails to execute"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "message"
        },
        {
          "name": "physician_name"
        },
        {
          "name": "specialty_name"
        },
        {
          "name": "start_date_time"
        },
        {
          "name": "appointments"
        }
      ]
    }
  },
  {
    "id": "H-vMrNavRkZtTf7linUOY",
    "type": "router",
    "label": "",
    "position": {
      "x": -2123.736328798325,
      "y": 2747.304234118912
    },
    "transitions": [
      {
        "condition": {
          "description": "Default fallback when no other conditions match"
        }
      },
      {
        "condition": {
          "description": "ALL conditions must be met"
        }
      },
      {
        "condition": {
          "description": "ALL conditions must be met"
        }
      }
    ]
  },
  {
    "id": "s1oM6Pdk8zqxDGWPDVZpq",
    "type": "conversation",
    "label": "",
    "position": {
      "x": -1551.770878521146,
      "y": 2339.673724670556
    },
    "message": "Tell the user the all departments first with the number of appointments in each department, then ask",
    "transitions": [
      {
        "condition": {
          "description": "when user asks about the available hours "
        }
      },
      {
        "condition": {
          "description": "When the user selects the preferred day or date for the new appointment."
        }
      },
      {
        "condition": {
          "description": "when user says i want to change the doctor "
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "current_appointment"
        },
        {
          "name": "physician_id"
        },
        {
          "name": "specialty_id"
        },
        {
          "name": "start_date_time"
        },
        {
          "name": "end_date_time"
        }
      ]
    }
  },
  {
    "id": "G5eKmgjDWWY56aV9t1wua",
    "type": "conversation",
    "label": "",
    "position": {
      "x": -1407.608191784932,
      "y": 3857.923180054422
    },
    "message": "say the below exactly:\nالمعذرة ما لقيت لك موعد مسجل ",
    "transitions": [
      {
        "condition": {
          "description": "Auto-advance"
        }
      }
    ]
  },
  {
    "id": "qET03QaBuPvauplZDiEX7",
    "type": "tool",
    "label": "last Get Available Appointments",
    "position": {
      "x": -972.8710993765804,
      "y": 2570.211564320568
    },
    "transitions": [
      {
        "condition": {
          "description": "When the tool completes successfully"
        }
      },
      {
        "condition": {
          "description": "When the tool fails to execute"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "availability"
        },
        {
          "name": "message5"
        }
      ]
    }
  },
  {
    "id": "Xyi9gSg4YJlyUJQR6yW_R",
    "type": "conversation",
    "label": "",
    "position": {
      "x": -95.30048747928386,
      "y": 2891.773908605772
    },
    "message": "{% for appointment in availability %}\nNora:\nالطبيب لديه موعد متاح في عيادة {{ appointment.specialtyN",
    "transitions": [
      {
        "condition": {
          "description": "When the user selects a valid date and time for the appointment.\n"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "new_appointment_id"
        }
      ]
    }
  },
  {
    "id": "MtI8zDc96S3N-oHl_ksc5",
    "type": "conversation",
    "label": "",
    "position": {
      "x": 2293.329049397989,
      "y": 2920.018837073775
    },
    "message": "say the below exactly:\n\nأبشر/ي أستاذ/تي تم تغيير الموعد مع {{physician_name}} في عيادة {{specialty_n",
    "transitions": [
      {
        "condition": {
          "description": "when user says no, thank you "
        }
      },
      {
        "condition": {
          "description": "When the user show gratitude in any way or say they don't need help"
        }
      }
    ]
  },
  {
    "id": "IWzYUNc6rE8_9ehWZH_Yz",
    "type": "tool",
    "label": "last Reschedule Appointment",
    "position": {
      "x": 1249.368388927064,
      "y": 2852.531536538828
    },
    "transitions": [
      {
        "condition": {
          "description": "When the tool completes successfully"
        }
      },
      {
        "condition": {
          "description": "When the tool fails to execute"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "start_date_time"
        },
        {
          "name": "physician_name"
        },
        {
          "name": "specialty_name"
        },
        {
          "name": "message7"
        }
      ]
    }
  },
  {
    "id": "gEDinsRUiG9UYPdBy2qPv",
    "type": "router",
    "label": "",
    "position": {
      "x": -1421.57562733954,
      "y": -139.0458623697792
    },
    "transitions": [
      {
        "condition": {
          "description": "Default fallback when no other conditions match"
        }
      },
      {
        "condition": {
          "description": "ALL conditions must be met"
        }
      },
      {
        "condition": {
          "description": "ALL conditions must be met"
        }
      },
      {
        "condition": {
          "description": "ALL conditions must be met"
        }
      }
    ]
  },
  {
    "id": "zxt66z0FkxaUnY0UG1hPy",
    "type": "tool",
    "label": "last Book Appointment",
    "position": {
      "x": -660.1005893533204,
      "y": -255.090105952509
    },
    "transitions": [
      {
        "condition": {
          "description": "When the tool completes successfully"
        }
      },
      {
        "condition": {
          "description": "When the tool fails to execute"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "details"
        },
        {
          "name": "appointment_id"
        },
        {
          "name": "clinic_floor"
        },
        {
          "name": "message0"
        }
      ]
    }
  },
  {
    "id": "uk4UNVgLe6eiQTM28bUGD",
    "type": "conversation",
    "label": "",
    "position": {
      "x": -2707.177114291243,
      "y": -242.2429202993745
    },
    "message": "ask user exactly:\nتمام أستاذي/تي ، هل يوجد ملف في المستشفى؟\nall right, do you have a file in the hos",
    "transitions": [
      {
        "condition": {
          "description": "if the user has a file "
        }
      },
      {
        "condition": {
          "description": "if the user doesn't have a file"
        }
      }
    ]
  },
  {
    "id": "3AwlzPDlqWlbhTP0wJoq3",
    "type": "router",
    "label": "",
    "position": {
      "x": 1717.02541050419,
      "y": 453.2029338292048
    },
    "transitions": [
      {
        "condition": {
          "description": "Default fallback when no other conditions match"
        }
      },
      {
        "condition": {
          "description": "ALL conditions must be met"
        }
      },
      {
        "condition": {
          "description": "ALL conditions must be met"
        }
      }
    ]
  },
  {
    "id": "I3eel1h7VywOXzGhEchU2",
    "type": "tool",
    "label": "last Check Patient Insurance",
    "position": {
      "x": 2897.26784841139,
      "y": 911.030721787806
    },
    "transitions": [
      {
        "condition": {
          "description": "When the tool completes successfully"
        }
      },
      {
        "condition": {
          "description": "When the tool fails to execute"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "message"
        }
      ]
    }
  },
  {
    "id": "d_qcuBkD6jRW51akUBU0q",
    "type": "conversation",
    "label": "",
    "position": {
      "x": 3858.293708887409,
      "y": 958.98237958269
    },
    "message": "Say the below exactly:\nSorry, your insurance is not covered\n\nعذرا تأمينك غير مغطى "
  },
  {
    "id": "xeSuZfzskGy0mlja7Deb-",
    "type": "router",
    "label": "",
    "position": {
      "x": 3282.201623389405,
      "y": 906.4491485636656
    },
    "transitions": [
      {
        "condition": {
          "description": "Default fallback when no other conditions match"
        }
      },
      {
        "condition": {
          "description": "ALL conditions must be met"
        }
      }
    ]
  },
  {
    "id": "zVEGBGZmC2BtSVmH6Ph0c",
    "type": "conversation",
    "label": "",
    "position": {
      "x": -3684.751977578211,
      "y": -939.2771823678482
    },
    "message": "{# \n   PURPOSE: The previous search returned NO available appointments.\n   This node tells the user ",
    "transitions": [
      {
        "condition": {
          "description": "When the user confirm"
        }
      },
      {
        "condition": {
          "description": "When the user provides the missing details"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "start_date_time_new"
        },
        {
          "name": "end_date_time_new"
        },
        {
          "name": "speciality_id_new"
        },
        {
          "name": "physician_id_new"
        },
        {
          "name": "physician_name_new"
        },
        {
          "name": "speciality_name_new"
        }
      ]
    }
  },
  {
    "id": "ejIDDiRI2l4zms81H38iB",
    "type": "router",
    "label": "",
    "position": {
      "x": -3456.9939429144,
      "y": -104.9061938088828
    },
    "transitions": [
      {
        "condition": {
          "description": "Default fallback when no other conditions match"
        }
      },
      {
        "condition": {
          "description": "ALL conditions must be met"
        }
      },
      {
        "condition": {
          "description": "ALL conditions must be met"
        }
      }
    ]
  },
  {
    "id": "DPt9PBoVzF5cl_ckZeHvh",
    "type": "tool",
    "label": "last Get Available Appointments",
    "position": {
      "x": -3092.378345508308,
      "y": -841.5031752966586
    },
    "transitions": [
      {
        "condition": {
          "description": "When the tool completes successfully"
        }
      },
      {
        "condition": {
          "description": "When the tool fails to execute"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "available_appointments"
        },
        {
          "name": "message"
        }
      ]
    }
  },
  {
    "id": "YoxkneazioSIsF-YxVJd9",
    "type": "conversation",
    "label": "",
    "position": {
      "x": -4221.10757420968,
      "y": -155.7636729868913
    },
    "message": "{# --- AVAILABLE DATA --- #}\nAvailable Specialties:\n{% for specialty in specialities %}\n{% if loop.i",
    "transitions": [
      {
        "condition": {
          "description": "when the user selects a physician "
        }
      },
      {
        "condition": {
          "description": "When the user say the soonest appointment "
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "start_date_time"
        },
        {
          "name": "end_date_time"
        },
        {
          "name": "speciality_id"
        },
        {
          "name": "physician_id"
        },
        {
          "name": "physician_name"
        },
        {
          "name": "speciality_name"
        }
      ]
    }
  },
  {
    "id": "ZKrcB-jL-RP1G8UErVrEV",
    "type": "router",
    "label": "",
    "position": {
      "x": -3804.640818761926,
      "y": 1962.291433582829
    },
    "transitions": [
      {
        "condition": {
          "description": "Default fallback when no other conditions match"
        }
      },
      {
        "condition": {
          "description": "ALL conditions must be met"
        }
      },
      {
        "condition": {
          "description": "ALL conditions must be met"
        }
      }
    ]
  },
  {
    "id": "68kkI-eU2RaHBkQ50cGCa",
    "type": "router",
    "label": "",
    "position": {
      "x": 1898.535177298811,
      "y": 1824.349870959208
    },
    "transitions": [
      {
        "condition": {
          "description": "Default fallback when no other conditions match"
        }
      },
      {
        "condition": {
          "description": "ALL conditions must be met"
        }
      },
      {
        "condition": {
          "description": "ALL conditions must be met"
        }
      }
    ]
  },
  {
    "id": "fDWBNPS4VTjkV4oKCZeba",
    "type": "router",
    "label": "",
    "position": {
      "x": -536.9819565491248,
      "y": 2974.480243995504
    },
    "transitions": [
      {
        "condition": {
          "description": "Default fallback when no other conditions match"
        }
      },
      {
        "condition": {
          "description": "ALL conditions must be met"
        }
      },
      {
        "condition": {
          "description": "ALL conditions must be met"
        }
      }
    ]
  },
  {
    "id": "P3r-7gaYE7YFzGRtowM1I",
    "type": "router",
    "label": "",
    "position": {
      "x": 683.0887486957288,
      "y": 2597.537537263303
    },
    "transitions": [
      {
        "condition": {
          "description": "Default fallback when no other conditions match"
        }
      },
      {
        "condition": {
          "description": "ALL conditions must be met"
        }
      },
      {
        "condition": {
          "description": "ALL conditions must be met"
        }
      },
      {
        "condition": {
          "description": "ALL conditions must be met"
        }
      }
    ]
  },
  {
    "id": "FmOGtK3PJtwn72xvhh7rX",
    "type": "router",
    "label": "",
    "position": {
      "x": 1813.785473726645,
      "y": 2997.220199665715
    },
    "transitions": [
      {
        "condition": {
          "description": "Default fallback when no other conditions match"
        }
      },
      {
        "condition": {
          "description": "ALL conditions must be met"
        }
      }
    ]
  },
  {
    "id": "fI_Z8gY8PcFfa0iP7jWWx",
    "type": "conversation",
    "label": "",
    "position": {
      "x": -2291.90279260747,
      "y": -1074.082296298829
    },
    "message": "{# Re-check / confirmation node before retrying patient search #}\n\nYou are continuing the same patie",
    "transitions": [
      {
        "condition": {
          "description": "when user provides phone number or id number"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "id_type_new"
        },
        {
          "name": "id_value_new"
        }
      ]
    }
  },
  {
    "id": "l9a4LG4fA3dj7-7J2No1f",
    "type": "tool",
    "label": "last Search Patient",
    "position": {
      "x": -1918.222539291118,
      "y": -1049.5977461428
    },
    "transitions": [
      {
        "condition": {
          "description": "When the tool completes successfully"
        }
      },
      {
        "condition": {
          "description": "When the tool fails to execute"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "message"
        },
        {
          "name": "patient_id"
        }
      ]
    }
  },
  {
    "id": "3AqdUWqm0vPXvdSLzZA6I",
    "type": "tool",
    "label": "last Create Patient Record",
    "position": {
      "x": 2182.661063136898,
      "y": -193.3324313831373
    },
    "transitions": [
      {
        "condition": {
          "description": "When the tool completes successfully"
        }
      },
      {
        "condition": {
          "description": "When the tool fails to execute"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "patient_id"
        },
        {
          "name": "message"
        }
      ]
    }
  },
  {
    "id": "0j5hsBUpBI3CQ6JT0s9MI",
    "type": "conversation",
    "label": "",
    "position": {
      "x": 1580.311245747681,
      "y": -604.844176184406
    },
    "message": "You are continuing the same patient file creation flow.\n\nYour goal is to confirm the critical patien",
    "transitions": [
      {
        "condition": {
          "description": "When the user confirm"
        }
      },
      {
        "condition": {
          "description": "When the user provides the missing details"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "first_name_ar_new"
        },
        {
          "name": "second_name_ar_new"
        },
        {
          "name": "third_name_ar_new"
        },
        {
          "name": "last_name_ar_new"
        },
        {
          "name": "first_name_en_new"
        },
        {
          "name": "second_name_en_new"
        },
        {
          "name": "third_name_en_new"
        },
        {
          "name": "last_name_en_new"
        },
        {
          "name": "id_value_new"
        },
        {
          "name": "dob_new"
        },
        {
          "name": "mobile_num_new"
        },
        {
          "name": "nationality_new"
        },
        {
          "name": "marital_status_new"
        }
      ]
    }
  },
  {
    "id": "1WW8Xa0VhuAPDNEj7B03K",
    "type": "conversation",
    "label": "",
    "position": {
      "x": -4099.590923928627,
      "y": 1205.502636001194
    },
    "message": "{# Re-check / confirmation node before retrying patient search #}\n\nYou are continuing the same patie",
    "transitions": [
      {
        "condition": {
          "description": "when user provides phone number or id number"
        }
      },
      {
        "condition": {
          "description": "When the user confirm the details"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "id_type_new"
        },
        {
          "name": "id_value_new"
        }
      ]
    }
  },
  {
    "id": "XSrf3GvMfK89vz3e05u12",
    "type": "conversation",
    "label": "",
    "position": {
      "x": -5125.871077103759,
      "y": 2080.229728070919
    },
    "message": "{# Re-check / confirmation node before retrying patient search #}\n\nYou are continuing the same patie",
    "transitions": [
      {
        "condition": {
          "description": "when user provides phone number or id number"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "id_type"
        },
        {
          "name": "id_value"
        }
      ]
    }
  },
  {
    "id": "hOt3gWqU_sDiTs3O0lZHx",
    "type": "conversation",
    "label": "",
    "position": {
      "x": -614.3466698016573,
      "y": -986.4450487739672
    },
    "message": "ask user exactly:\n لقيت اكثر من ملف على هذا الرقم. أحتاج فضلاً  اعرف رقم الهوية الوطنية او الاقامة ؟",
    "transitions": [
      {
        "condition": {
          "description": "when user provides id number"
        }
      },
      {
        "condition": {
          "description": "when user confirms id number"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "id_type_dup"
        },
        {
          "name": "id_value_dup"
        }
      ]
    }
  },
  {
    "id": "KCa--nLOSkmh00PW75iyg",
    "type": "tool",
    "label": "last Search Patient",
    "position": {
      "x": -30.00287003351832,
      "y": -1018.549444896438
    },
    "transitions": [
      {
        "condition": {
          "description": "When the tool completes successfully"
        }
      },
      {
        "condition": {
          "description": "When the tool fails to execute"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "message"
        },
        {
          "name": "patient_id"
        }
      ]
    }
  },
  {
    "id": "MbA6yaWELf4fgc6_O0fq_",
    "type": "tool",
    "label": "last Search Patient",
    "position": {
      "x": -2563.756767856195,
      "y": 1020.629734118529
    },
    "transitions": [
      {
        "condition": {
          "description": "When the tool completes successfully"
        }
      },
      {
        "condition": {
          "description": "When the tool fails to execute"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "patient_id"
        },
        {
          "name": "message2"
        }
      ]
    }
  },
  {
    "id": "n8yjnTPb-zrnsXd8eSOM3",
    "type": "conversation",
    "label": "",
    "position": {
      "x": -1468.524218356165,
      "y": -822.3063945372213
    },
    "message": "ask user exactly:\n\n\"لم يتم العثور على ملف بهذه البيانات، ممكن نتأكد مرة ثانية؟ هل الملف على رقم الجو",
    "transitions": [
      {
        "condition": {
          "description": "when user provides phone number or id number"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "new_id_type"
        },
        {
          "name": "new_id_value"
        }
      ]
    }
  },
  {
    "id": "rG42hWBIkC3IEmfhfnWQh",
    "type": "tool",
    "label": "last Search Patient",
    "position": {
      "x": -1068.328088544584,
      "y": -816.6286116626504
    },
    "transitions": [
      {
        "condition": {
          "description": "When the tool completes successfully"
        }
      },
      {
        "condition": {
          "description": "When the tool fails to execute"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "message"
        },
        {
          "name": "patient_id"
        }
      ]
    }
  },
  {
    "id": "r30BWO2o7zylvqIDjXjrU",
    "type": "conversation",
    "label": "",
    "position": {
      "x": -3048.877542018241,
      "y": 997.661234328462
    },
    "message": "ask user exactly:\n لقيت اكثر من ملف على هذا الرقم. أحتاج فضلاً  اعرف رقم الهوية الوطنية او الاقامة ؟",
    "transitions": [
      {
        "condition": {
          "description": "when user provides id number"
        }
      },
      {
        "condition": {
          "description": "when user confirms id number"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "id_type_dup"
        },
        {
          "name": "id_value_dup"
        }
      ]
    }
  },
  {
    "id": "FDiCyisnetyBSxVrCkMbN",
    "type": "tool",
    "label": "last Search Patient",
    "position": {
      "x": -3653.43714809236,
      "y": 1248.494272115087
    },
    "transitions": [
      {
        "condition": {
          "description": "When the tool completes successfully"
        }
      },
      {
        "condition": {
          "description": "When the tool fails to execute"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "message2"
        },
        {
          "name": "patient_id"
        }
      ]
    }
  },
  {
    "id": "qKoIIB--Ovbe_uba8NKAO",
    "type": "router",
    "label": "",
    "position": {
      "x": -276.0804640185057,
      "y": -204.6848481310907
    },
    "transitions": [
      {
        "condition": {
          "description": "Default fallback when no other conditions match"
        }
      },
      {
        "condition": {
          "description": "ALL conditions must be met"
        }
      },
      {
        "condition": {
          "description": "ALL conditions must be met"
        }
      },
      {
        "condition": {
          "description": "ALL conditions must be met"
        }
      }
    ]
  },
  {
    "id": "Tr6eCTuEvv6T_L4IJg5cb",
    "type": "conversation",
    "label": "",
    "position": {
      "x": 1013.964003511114,
      "y": -2835.087441483502
    },
    "message": "say the below exactly:\nThe patient has another appointment at the same time in the same specialty.",
    "transitions": [
      {
        "condition": {
          "description": "Auto-advance"
        }
      }
    ]
  },
  {
    "id": "CBvahOevz1Rqx2cPA2TgQ",
    "type": "conversation",
    "label": "",
    "position": {
      "x": -5100.099843472184,
      "y": -527.248980026625
    },
    "message": "If the user mentioned they have pain, show empathy and help them choose the clinic accordinlgy.\n\n{% ",
    "transitions": [
      {
        "condition": {
          "description": "When the user choose the speciality or department"
        }
      },
      {
        "condition": {
          "description": "When the user confirm the speciality "
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "speciality_id_extracted"
        }
      ]
    }
  },
  {
    "id": "2bm7O6U6-jirUXOmE513R",
    "type": "tool",
    "label": "last Get Booked Appointments",
    "position": {
      "x": -4132.550423650324,
      "y": 2965.718849906143
    },
    "transitions": [
      {
        "condition": {
          "description": "When the tool completes successfully"
        }
      },
      {
        "condition": {
          "description": "When the tool fails to execute"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "message"
        },
        {
          "name": "physician_name"
        },
        {
          "name": "specialty_name"
        },
        {
          "name": "start_date_time"
        },
        {
          "name": "appointments"
        },
        {
          "name": "patient_id"
        }
      ]
    }
  },
  {
    "id": "V9QfwAhnKzQ_6ZFnxLcVO",
    "type": "conversation",
    "label": "",
    "position": {
      "x": -3459.05447704976,
      "y": 3079.269950234464
    },
    "message": "{% for appointment in appointments %}\n\nTell the user the all departments first with the number of ap",
    "transitions": [
      {
        "condition": {
          "description": "When the user needs to cancel and appointment and they have confirmed the cancellation"
        }
      },
      {
        "condition": {
          "description": "when user choose the appointment would like to reschedule and confirm it"
        }
      },
      {
        "condition": {
          "description": "When the user chooses the date or the time of the appointment "
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "canceled_appointment"
        },
        {
          "name": "current_appointment"
        }
      ]
    }
  },
  {
    "id": "ER9ehxsOaCd0HXXJOKINp",
    "type": "conversation",
    "label": "",
    "position": {
      "x": -91.68194201381874,
      "y": 3454.831869504258
    },
    "message": "say the below exactly:\nThe patient has another appointment at the same time. \nتحب اشوفلك موعد ثاني؟",
    "transitions": [
      {
        "condition": {
          "description": "Auto-advance"
        }
      }
    ]
  },
  {
    "id": "WM_0cwu6Ffggf1yil_tpS",
    "type": "tool",
    "label": "last Get Available Appointments",
    "position": {
      "x": 774.7015758936705,
      "y": 3405.422456201522
    },
    "transitions": [
      {
        "condition": {
          "description": "When the tool completes successfully"
        }
      },
      {
        "condition": {
          "description": "When the tool fails to execute"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "availability"
        },
        {
          "name": "message5"
        }
      ]
    }
  },
  {
    "id": "-4rJcCz-55NntjZLS0mPm",
    "type": "conversation",
    "label": "",
    "position": {
      "x": 302.7440966830139,
      "y": 3333.818654595593
    },
    "message": "{% for appointment in appointments %}\nعندك موعد مع الدكتور {{ appointment.physicianName }} في عيادة ",
    "transitions": [
      {
        "condition": {
          "description": "when user asks about the available hours "
        }
      },
      {
        "condition": {
          "description": "When the user selects the preferred day or date for the new appointment."
        }
      },
      {
        "condition": {
          "description": "when user says i want to change the doctor "
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "current_appointment"
        },
        {
          "name": "physician_id"
        },
        {
          "name": "specialty_id"
        },
        {
          "name": "start_date_time"
        },
        {
          "name": "end_date_time"
        }
      ]
    }
  },
  {
    "id": "gp3iUMNORVhAgucTzMGai",
    "type": "router",
    "label": "",
    "position": {
      "x": -2808.16123418888,
      "y": 542.4422288738824
    },
    "transitions": [
      {
        "condition": {
          "description": "Default fallback when no other conditions match"
        }
      },
      {
        "condition": {
          "description": "ALL conditions must be met"
        }
      }
    ]
  },
  {
    "id": "gmy7By3zesKQ3O8R_SJfg",
    "type": "router",
    "label": "",
    "position": {
      "x": -3196.141108592522,
      "y": 1923.438560616958
    },
    "transitions": [
      {
        "condition": {
          "description": "Default fallback when no other conditions match"
        }
      },
      {
        "condition": {
          "description": "ALL conditions must be met"
        }
      },
      {
        "condition": {
          "description": "ALL conditions must be met"
        }
      },
      {
        "condition": {
          "description": "ALL conditions must be met"
        }
      }
    ]
  },
  {
    "id": "vBJBD3FKF_BTlyZmsMFK-",
    "type": "conversation",
    "label": "",
    "position": {
      "x": -1275.607885168447,
      "y": 3045.673601008152
    },
    "message": "Say the below:\n\nللاسف ما في موعيد متاحه بالوقت اللي اخترته، متى تحب اشوف مواعيد ثانية؟ ",
    "transitions": [
      {
        "condition": {
          "description": "when user asks about the available hours "
        }
      },
      {
        "condition": {
          "description": "When the user selects the preferred day or date for the new appointment."
        }
      },
      {
        "condition": {
          "description": "when user says i want to change the doctor "
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "current_appointment"
        },
        {
          "name": "physician_id"
        },
        {
          "name": "specialty_id"
        },
        {
          "name": "start_date_time"
        },
        {
          "name": "end_date_time"
        }
      ]
    }
  },
  {
    "id": "gsvvh7NjfYJt6tZVb-fwz",
    "type": "conversation",
    "label": "",
    "position": {
      "x": 1398.22270309993,
      "y": -1195.01106003994
    },
    "message": "{%- if available_appointments and available_appointments | length > 0 %}\nAvailable appointments:\n{%-",
    "transitions": [
      {
        "condition": {
          "description": "when the user picks a timeslot"
        }
      },
      {
        "condition": {
          "description": "When the user chooses the appointment date or time "
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "new_appointment_id"
        },
        {
          "name": "appointment_date_time"
        }
      ]
    }
  },
  {
    "id": "j8jXc9YE4iEedzd-I59gq",
    "type": "conversation",
    "label": "",
    "position": {
      "x": 671.2639287821623,
      "y": -1100.543883000278
    },
    "message": "{%- if available_appointments and available_appointments | length > 0 %}\nAvailable appointments:\n{%-",
    "transitions": [
      {
        "condition": {
          "description": "when the user picks a timeslot"
        }
      },
      {
        "condition": {
          "description": "When the user chooses the appointment date or time "
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "new_appointment_id"
        },
        {
          "name": "appointment_date_time"
        }
      ]
    }
  },
  {
    "id": "1cEJOwf4o3XpI_biKR6eY",
    "type": "conversation",
    "label": "",
    "position": {
      "x": -3510.465015113145,
      "y": 448.0603573901604
    },
    "message": "Confirm with the user the date and time below: \n\nSay the below exactly: \nبعتذر بس في مشكله في هذا ال",
    "transitions": [
      {
        "condition": {
          "description": "When the user confirm the date and time  in anyway"
        }
      },
      {
        "condition": {
          "description": "When the user say the soonest appointment "
        }
      },
      {
        "condition": {
          "description": "When the user asks for a new date or time in anyway"
        }
      }
    ],
    "extractVariables": {
      "variables": [
        {
          "name": "start_date_time"
        }
      ]
    }
  }
];

export const REAL_WORKFLOW_EDGES = [
  {
    "id": "UWmAAcca998a0dO_Tjbiv",
    "source": "GhD_GaH9HWllK7-HHDqhP",
    "target": "Xd_NDZuaqNfclntcn7hsq"
  },
  {
    "id": "Jo6aYxGkOzftTq3tiWLzy",
    "source": "2PWmvqOTPXr2mXvEzIG7f",
    "target": "4v_-WdOGcSHh7eB3Gnrv1"
  },
  {
    "id": "6-WXQUzkYRTeyGN0ewvzs",
    "source": "IvXZoJJuixEoaVoU4cMBm",
    "target": "HYHcV_n36IBV4N597WJNv"
  },
  {
    "id": "2g-43x9GOxxG2FXOXxkRN",
    "source": "HYHcV_n36IBV4N597WJNv",
    "target": "qT57Ura7ITUMXgsz4SQML"
  },
  {
    "id": "2TpdT0m3RpGLaGGZeFOJS",
    "source": "qT57Ura7ITUMXgsz4SQML",
    "target": "25Ox6Gto5O0Vj9vq8C4Y1"
  },
  {
    "id": "0mF3QqRf8oa6hPcgkoFBU",
    "source": "oeaHIh_c4Ha71vmy0N0_K",
    "target": "O7VPR24xqKDncFbi9ciPU"
  },
  {
    "id": "In11zm-0VA7x02jYXnKDb",
    "source": "oeaHIh_c4Ha71vmy0N0_K",
    "target": "PD3ihB75qZWR5NNP78Onz"
  },
  {
    "id": "WFlsnJJAGtQKJkzrIorR7",
    "source": "O7VPR24xqKDncFbi9ciPU",
    "target": "PD3ihB75qZWR5NNP78Onz"
  },
  {
    "id": "9puCdxlBTElE_AxSFE__-",
    "source": "AqeuHq-_0yILckazKZxiX",
    "target": "BtmGvfS-yEytMKctb5jz0"
  },
  {
    "id": "QVCvby8b0xuay83aeMHv0",
    "source": "jym_qkZxHT08ezfVfz9AB",
    "target": "kOOrWZfgSoBpMIU8-_lor"
  },
  {
    "id": "nS1Y147B7Hicq6JXFflL_",
    "source": "PD3ihB75qZWR5NNP78Onz",
    "target": "qCHH_yDYmAyD9BQyrGlll"
  },
  {
    "id": "0NSrUmLkdqLDdnF_rycPI",
    "source": "kOOrWZfgSoBpMIU8-_lor",
    "target": "BtmGvfS-yEytMKctb5jz0"
  },
  {
    "id": "A0SO7CdMnlZLcGC74F2p5",
    "source": "vQ7DXP_gvH62TXFya-XbO",
    "target": "jym_qkZxHT08ezfVfz9AB"
  },
  {
    "id": "cVgnYAAtU89B25Z1pQFpf",
    "source": "jym_qkZxHT08ezfVfz9AB",
    "target": "o95EhUGtU205oArqOVQaX"
  },
  {
    "id": "UJxC1XneCZWjLdR8NWFgR",
    "source": "o95EhUGtU205oArqOVQaX",
    "target": "uC3w0YluqoEXMIQQ9Q00u"
  },
  {
    "id": "q22ceQRhJdHK0djofz_HL",
    "source": "vi_2bJz5byjhl9xQtm2MI",
    "target": "H-vMrNavRkZtTf7linUOY"
  },
  {
    "id": "QHYFAdlqDn50y8g5Rnf--",
    "source": "H-vMrNavRkZtTf7linUOY",
    "target": "s1oM6Pdk8zqxDGWPDVZpq"
  },
  {
    "id": "_lZM7BNBpqZMKdWdh0vwo",
    "source": "H-vMrNavRkZtTf7linUOY",
    "target": "G5eKmgjDWWY56aV9t1wua"
  },
  {
    "id": "b6Z-WStDw2Z5Yxt1ktltk",
    "source": "G5eKmgjDWWY56aV9t1wua",
    "target": "BtmGvfS-yEytMKctb5jz0"
  },
  {
    "id": "X_YvGf8mHmn82KZlkLoFT",
    "source": "s1oM6Pdk8zqxDGWPDVZpq",
    "target": "qET03QaBuPvauplZDiEX7"
  },
  {
    "id": "GRqTvZrmmY-YqXXETf8Qd",
    "source": "s1oM6Pdk8zqxDGWPDVZpq",
    "target": "qET03QaBuPvauplZDiEX7"
  },
  {
    "id": "ZUCO06DGpv30n0YUI2XB1",
    "source": "MtI8zDc96S3N-oHl_ksc5",
    "target": "BtmGvfS-yEytMKctb5jz0"
  },
  {
    "id": "hLgSUCLmTLLl_QpYF_SlU",
    "source": "Xd_NDZuaqNfclntcn7hsq",
    "target": "gEDinsRUiG9UYPdBy2qPv"
  },
  {
    "id": "y2jSt4IW6knzofF15rYhL",
    "source": "gEDinsRUiG9UYPdBy2qPv",
    "target": "zxt66z0FkxaUnY0UG1hPy"
  },
  {
    "id": "qSZ6oeclfX7A4XLsRtUjS",
    "source": "LK472OyeDGcBUOTgRH7j_",
    "target": "rtzXHd9oAUJCnq3lIMYtZ"
  },
  {
    "id": "ZuVG08VeHI3TRFbOjD9eW",
    "source": "rtzXHd9oAUJCnq3lIMYtZ",
    "target": "IvXZoJJuixEoaVoU4cMBm"
  },
  {
    "id": "YtgRGOH_cBqTZOQakJB_-",
    "source": "bgUbMDsuDRR5uHi5WYYLO",
    "target": "oeaHIh_c4Ha71vmy0N0_K"
  },
  {
    "id": "ZrTBQC7DrJbhqzXLQwKUo",
    "source": "uk4UNVgLe6eiQTM28bUGD",
    "target": "GhD_GaH9HWllK7-HHDqhP"
  },
  {
    "id": "XCoSZJju7x7tYxqnYUEH2",
    "source": "uk4UNVgLe6eiQTM28bUGD",
    "target": "LK472OyeDGcBUOTgRH7j_"
  },
  {
    "id": "AkFBNYGMuzXI-182Gkc0s",
    "source": "25Ox6Gto5O0Vj9vq8C4Y1",
    "target": "0tTHX_gc3J6nXEVg5uc2R"
  },
  {
    "id": "3YdUjSkOXFdbD3NP8mmkY",
    "source": "0tTHX_gc3J6nXEVg5uc2R",
    "target": "in6pdDMfyI7OQW-hCfrHD"
  },
  {
    "id": "WMyRMeVdkCf76Covu8caq",
    "source": "aptpXj4Q7jf5Fwa315rmW",
    "target": "3AwlzPDlqWlbhTP0wJoq3"
  },
  {
    "id": "RGniSZtaMrQ7-lq0FZgXQ",
    "source": "s1oM6Pdk8zqxDGWPDVZpq",
    "target": "4HqTkjaMDrTCVZf26ntTV"
  },
  {
    "id": "FmbamBuWWFbTuaDmDio5G",
    "source": "3AwlzPDlqWlbhTP0wJoq3",
    "target": "zxt66z0FkxaUnY0UG1hPy"
  },
  {
    "id": "4il9fOjJADiaOxVA0R8zx",
    "source": "I3eel1h7VywOXzGhEchU2",
    "target": "xeSuZfzskGy0mlja7Deb-"
  },
  {
    "id": "BUaO263QC1zshq8p0R6-4",
    "source": "4ujek527tG2zR9tj6ZlfX",
    "target": "ejIDDiRI2l4zms81H38iB"
  },
  {
    "id": "3qJUNNxAw6PV3PkwwO8HW",
    "source": "ejIDDiRI2l4zms81H38iB",
    "target": "YDMXOjdIOcIH92kDtk4Ey"
  },
  {
    "id": "514w_TH5anOzmZN32iHyd",
    "source": "zVEGBGZmC2BtSVmH6Ph0c",
    "target": "DPt9PBoVzF5cl_ckZeHvh"
  },
  {
    "id": "I9eni6Zw-C1d4nOdSxBQD",
    "source": "DPt9PBoVzF5cl_ckZeHvh",
    "target": "ejIDDiRI2l4zms81H38iB"
  },
  {
    "id": "XKYpiRsZUq-Cv5-HVki3Z",
    "source": "YYsR_hgqdyBNyQSAUQwva",
    "target": "YoxkneazioSIsF-YxVJd9"
  },
  {
    "id": "cGN_y0gW1Jd29vDyTvuzo",
    "source": "YoxkneazioSIsF-YxVJd9",
    "target": "4ujek527tG2zR9tj6ZlfX"
  },
  {
    "id": "FtsIS4xqtg-GEwZRW5FU8",
    "source": "qCHH_yDYmAyD9BQyrGlll",
    "target": "ZKrcB-jL-RP1G8UErVrEV"
  },
  {
    "id": "nmoMcG8DhNViNNbhybldR",
    "source": "uC3w0YluqoEXMIQQ9Q00u",
    "target": "68kkI-eU2RaHBkQ50cGCa"
  },
  {
    "id": "O6NCofSiO-8uJNB-ePTjS",
    "source": "68kkI-eU2RaHBkQ50cGCa",
    "target": "AqeuHq-_0yILckazKZxiX"
  },
  {
    "id": "ZgkVml_bHmbaMJboePBKM",
    "source": "qET03QaBuPvauplZDiEX7",
    "target": "fDWBNPS4VTjkV4oKCZeba"
  },
  {
    "id": "ik-SYs8OuK78YNNbqZ-YG",
    "source": "fDWBNPS4VTjkV4oKCZeba",
    "target": "Xyi9gSg4YJlyUJQR6yW_R"
  },
  {
    "id": "EGGPssCGob39LhmNTKbtD",
    "source": "P3r-7gaYE7YFzGRtowM1I",
    "target": "IWzYUNc6rE8_9ehWZH_Yz"
  },
  {
    "id": "WU7j6blZNuDwLUgxsGMGu",
    "source": "IWzYUNc6rE8_9ehWZH_Yz",
    "target": "FmOGtK3PJtwn72xvhh7rX"
  },
  {
    "id": "k48ZARtDxOfg9yTiLFXNJ",
    "source": "FmOGtK3PJtwn72xvhh7rX",
    "target": "MtI8zDc96S3N-oHl_ksc5"
  },
  {
    "id": "_FHp9X-k5iepnMiDtDqDS",
    "source": "gEDinsRUiG9UYPdBy2qPv",
    "target": "fI_Z8gY8PcFfa0iP7jWWx"
  },
  {
    "id": "UCQqtk_CsX1rGK7iu-Hbe",
    "source": "fI_Z8gY8PcFfa0iP7jWWx",
    "target": "l9a4LG4fA3dj7-7J2No1f"
  },
  {
    "id": "FltDAqWDzrt6QuX1KBqTY",
    "source": "l9a4LG4fA3dj7-7J2No1f",
    "target": "gEDinsRUiG9UYPdBy2qPv"
  },
  {
    "id": "wA9S1FrOyxvMQK22MPPxO",
    "source": "YoxkneazioSIsF-YxVJd9",
    "target": "4ujek527tG2zR9tj6ZlfX"
  },
  {
    "id": "62shsygkLOoVMt4480l67",
    "source": "zVEGBGZmC2BtSVmH6Ph0c",
    "target": "DPt9PBoVzF5cl_ckZeHvh"
  },
  {
    "id": "xIjQWxyKk9uZf5iUhdMzx",
    "source": "3AqdUWqm0vPXvdSLzZA6I",
    "target": "3AwlzPDlqWlbhTP0wJoq3"
  },
  {
    "id": "evWVoM0mJvgcXof_DNLjZ",
    "source": "3AwlzPDlqWlbhTP0wJoq3",
    "target": "0j5hsBUpBI3CQ6JT0s9MI"
  },
  {
    "id": "3vcdthp6Xm6FgCyK8w30R",
    "source": "0j5hsBUpBI3CQ6JT0s9MI",
    "target": "3AqdUWqm0vPXvdSLzZA6I"
  },
  {
    "id": "qVEhtRJPSVlAJAU81nsIf",
    "source": "0j5hsBUpBI3CQ6JT0s9MI",
    "target": "3AqdUWqm0vPXvdSLzZA6I"
  },
  {
    "id": "IaNGDTbidl1aZa-yf7zF1",
    "source": "ZKrcB-jL-RP1G8UErVrEV",
    "target": "1WW8Xa0VhuAPDNEj7B03K"
  },
  {
    "id": "XekO2JsErJK2h6qusAUDp",
    "source": "in6pdDMfyI7OQW-hCfrHD",
    "target": "aptpXj4Q7jf5Fwa315rmW"
  },
  {
    "id": "KzkMnh5xYVFZtPpyL1Dya",
    "source": "hOt3gWqU_sDiTs3O0lZHx",
    "target": "KCa--nLOSkmh00PW75iyg"
  },
  {
    "id": "mMV-OvJcwEqB3yX9BDzEU",
    "source": "hOt3gWqU_sDiTs3O0lZHx",
    "target": "KCa--nLOSkmh00PW75iyg"
  },
  {
    "id": "82rJk3lB9Qn1UFLK_z6ty",
    "source": "KCa--nLOSkmh00PW75iyg",
    "target": "gEDinsRUiG9UYPdBy2qPv"
  },
  {
    "id": "2MJx8xIPjMziyGATCg8cl",
    "source": "gEDinsRUiG9UYPdBy2qPv",
    "target": "hOt3gWqU_sDiTs3O0lZHx"
  },
  {
    "id": "VAk0ItlfPliPtPz5KHbB1",
    "source": "68kkI-eU2RaHBkQ50cGCa",
    "target": "AqeuHq-_0yILckazKZxiX"
  },
  {
    "id": "toFfkA3TUvRtCHZS7V9WD",
    "source": "gEDinsRUiG9UYPdBy2qPv",
    "target": "n8yjnTPb-zrnsXd8eSOM3"
  },
  {
    "id": "KudrSF_GqQmHzRrIsys2-",
    "source": "n8yjnTPb-zrnsXd8eSOM3",
    "target": "rG42hWBIkC3IEmfhfnWQh"
  },
  {
    "id": "zHoYTWzyPFTE_ihvJDO1s",
    "source": "rG42hWBIkC3IEmfhfnWQh",
    "target": "gEDinsRUiG9UYPdBy2qPv"
  },
  {
    "id": "IavX7_xpVRNd1qu844VTw",
    "source": "r30BWO2o7zylvqIDjXjrU",
    "target": "MbA6yaWELf4fgc6_O0fq_"
  },
  {
    "id": "a4u4VNYvITuDWP3GLCJH5",
    "source": "r30BWO2o7zylvqIDjXjrU",
    "target": "MbA6yaWELf4fgc6_O0fq_"
  },
  {
    "id": "MUrJW0tIqtGTj_OzeewqK",
    "source": "1WW8Xa0VhuAPDNEj7B03K",
    "target": "FDiCyisnetyBSxVrCkMbN"
  },
  {
    "id": "J2qsEbMK4TUlEbdVZkOYL",
    "source": "FDiCyisnetyBSxVrCkMbN",
    "target": "ZKrcB-jL-RP1G8UErVrEV"
  },
  {
    "id": "U3rDyTzSWA20dwT9d9vJ4",
    "source": "zxt66z0FkxaUnY0UG1hPy",
    "target": "qKoIIB--Ovbe_uba8NKAO"
  },
  {
    "id": "-cc7DewNrnxHoQoo6Ov37",
    "source": "qKoIIB--Ovbe_uba8NKAO",
    "target": "2PWmvqOTPXr2mXvEzIG7f"
  },
  {
    "id": "jn3frXIXDGyOmUlB_qtAr",
    "source": "qKoIIB--Ovbe_uba8NKAO",
    "target": "Tr6eCTuEvv6T_L4IJg5cb"
  },
  {
    "id": "uVel0h7b8O5vdQiYelH3y",
    "source": "Tr6eCTuEvv6T_L4IJg5cb",
    "target": "4HqTkjaMDrTCVZf26ntTV"
  },
  {
    "id": "U_utOC8QijSED285Ow5z3",
    "source": "bgUbMDsuDRR5uHi5WYYLO",
    "target": "4HqTkjaMDrTCVZf26ntTV"
  },
  {
    "id": "QIkoZfsnAmbwmfBE33su8",
    "source": "bgUbMDsuDRR5uHi5WYYLO",
    "target": "4HqTkjaMDrTCVZf26ntTV"
  },
  {
    "id": "KJxlGEu6H59HQ2xi-2lPJ",
    "source": "4HqTkjaMDrTCVZf26ntTV",
    "target": "CBvahOevz1Rqx2cPA2TgQ"
  },
  {
    "id": "pQY-hXpz7hsM2ghRHeobi",
    "source": "CBvahOevz1Rqx2cPA2TgQ",
    "target": "YYsR_hgqdyBNyQSAUQwva"
  },
  {
    "id": "qkvlFwG_PxBcZ8ncWxdn2",
    "source": "CBvahOevz1Rqx2cPA2TgQ",
    "target": "YYsR_hgqdyBNyQSAUQwva"
  },
  {
    "id": "zw1g7Jo_y0WqwnG-Z_lmn",
    "source": "bgUbMDsuDRR5uHi5WYYLO",
    "target": "4HqTkjaMDrTCVZf26ntTV"
  },
  {
    "id": "X6Ge9NHTMgesmJotZyMzL",
    "source": "LK472OyeDGcBUOTgRH7j_",
    "target": "rtzXHd9oAUJCnq3lIMYtZ"
  },
  {
    "id": "S4opENHo_7289om-BV54v",
    "source": "2PWmvqOTPXr2mXvEzIG7f",
    "target": "4v_-WdOGcSHh7eB3Gnrv1"
  },
  {
    "id": "IJpjvPq1BCvVIxNfj9Q6N",
    "source": "2bm7O6U6-jirUXOmE513R",
    "target": "V9QfwAhnKzQ_6ZFnxLcVO"
  },
  {
    "id": "gfgU2GLidmCapClIwl6W6",
    "source": "V9QfwAhnKzQ_6ZFnxLcVO",
    "target": "uC3w0YluqoEXMIQQ9Q00u"
  },
  {
    "id": "lUdX5TPscoqRrGznNm3jP",
    "source": "ejIDDiRI2l4zms81H38iB",
    "target": "zVEGBGZmC2BtSVmH6Ph0c"
  },
  {
    "id": "n8z9FnQCVx9aD_wTN515A",
    "source": "fDWBNPS4VTjkV4oKCZeba",
    "target": "ER9ehxsOaCd0HXXJOKINp"
  },
  {
    "id": "wk6S0InC9v2pJw0G8DnVg",
    "source": "WM_0cwu6Ffggf1yil_tpS",
    "target": "fDWBNPS4VTjkV4oKCZeba"
  },
  {
    "id": "HaCRrWXklhcJOJqzsNhJz",
    "source": "P3r-7gaYE7YFzGRtowM1I",
    "target": "XSrf3GvMfK89vz3e05u12"
  },
  {
    "id": "egOftZzJOgT3MPf9mlnWm",
    "source": "ER9ehxsOaCd0HXXJOKINp",
    "target": "-4rJcCz-55NntjZLS0mPm"
  },
  {
    "id": "bFcTHsrP4X86fYj7EmLzJ",
    "source": "-4rJcCz-55NntjZLS0mPm",
    "target": "WM_0cwu6Ffggf1yil_tpS"
  },
  {
    "id": "EEJINg-Dfo3ch0KyeaWeA",
    "source": "-4rJcCz-55NntjZLS0mPm",
    "target": "WM_0cwu6Ffggf1yil_tpS"
  },
  {
    "id": "UQ0zcmJwdFUdbiWSDE7CF",
    "source": "-4rJcCz-55NntjZLS0mPm",
    "target": "4HqTkjaMDrTCVZf26ntTV"
  },
  {
    "id": "_rQmxDkfQBMl2pSa9nl0T",
    "source": "AqeuHq-_0yILckazKZxiX",
    "target": "BtmGvfS-yEytMKctb5jz0"
  },
  {
    "id": "WIKn36K_7-TxViiaHVWlE",
    "source": "MtI8zDc96S3N-oHl_ksc5",
    "target": "BtmGvfS-yEytMKctb5jz0"
  },
  {
    "id": "TrTeD8tJmUMa7KokXMdCJ",
    "source": "Xyi9gSg4YJlyUJQR6yW_R",
    "target": "IWzYUNc6rE8_9ehWZH_Yz"
  },
  {
    "id": "ZDHL2LnTd4f4gQM4n33Vs",
    "source": "YDMXOjdIOcIH92kDtk4Ey",
    "target": "gp3iUMNORVhAgucTzMGai"
  },
  {
    "id": "3URxuleJyEVtlXsfakoPE",
    "source": "gp3iUMNORVhAgucTzMGai",
    "target": "uk4UNVgLe6eiQTM28bUGD"
  },
  {
    "id": "CkuSWM6NaMET5KZaTI1sx",
    "source": "gp3iUMNORVhAgucTzMGai",
    "target": "IWzYUNc6rE8_9ehWZH_Yz"
  },
  {
    "id": "gjS9vmTMjqa4_TkQ_gZNJ",
    "source": "bgUbMDsuDRR5uHi5WYYLO",
    "target": "oeaHIh_c4Ha71vmy0N0_K"
  },
  {
    "id": "Ha3ZT8z4UUScFzOdfmq6_",
    "source": "bgUbMDsuDRR5uHi5WYYLO",
    "target": "oeaHIh_c4Ha71vmy0N0_K"
  },
  {
    "id": "YMoqZ_TfpoCwG0m8Yy_x5",
    "source": "bgUbMDsuDRR5uHi5WYYLO",
    "target": "oeaHIh_c4Ha71vmy0N0_K"
  },
  {
    "id": "RNPz1GqCwBrDrAu1Iv2ZO",
    "source": "ZKrcB-jL-RP1G8UErVrEV",
    "target": "gmy7By3zesKQ3O8R_SJfg"
  },
  {
    "id": "kMZwnmNbUwyUVz8h3DDrV",
    "source": "gmy7By3zesKQ3O8R_SJfg",
    "target": "vQ7DXP_gvH62TXFya-XbO"
  },
  {
    "id": "zlo8a43epwp09toq9ksyq",
    "source": "gmy7By3zesKQ3O8R_SJfg",
    "target": "vi_2bJz5byjhl9xQtm2MI"
  },
  {
    "id": "q2iXXeMz5cGbneWkkBfRU",
    "source": "ZKrcB-jL-RP1G8UErVrEV",
    "target": "r30BWO2o7zylvqIDjXjrU"
  },
  {
    "id": "aPH78mEIfPwN552hHznav",
    "source": "MbA6yaWELf4fgc6_O0fq_",
    "target": "ZKrcB-jL-RP1G8UErVrEV"
  },
  {
    "id": "gXsqsrd-EdDuBvHmLelum",
    "source": "XSrf3GvMfK89vz3e05u12",
    "target": "qCHH_yDYmAyD9BQyrGlll"
  },
  {
    "id": "S4GGP1fzb09lZpvoQ4Y1Q",
    "source": "gmy7By3zesKQ3O8R_SJfg",
    "target": "2bm7O6U6-jirUXOmE513R"
  },
  {
    "id": "KonzPOl8ucztTyVLszuWu",
    "source": "V9QfwAhnKzQ_6ZFnxLcVO",
    "target": "s1oM6Pdk8zqxDGWPDVZpq"
  },
  {
    "id": "Qhoha1WIDD7z2IReQRXMd",
    "source": "vBJBD3FKF_BTlyZmsMFK-",
    "target": "qET03QaBuPvauplZDiEX7"
  },
  {
    "id": "_BlBDrNlqw1Eg3Clzwav5",
    "source": "vBJBD3FKF_BTlyZmsMFK-",
    "target": "qET03QaBuPvauplZDiEX7"
  },
  {
    "id": "MAISjx7CGm_4oDl4Q4sPu",
    "source": "vBJBD3FKF_BTlyZmsMFK-",
    "target": "qET03QaBuPvauplZDiEX7"
  },
  {
    "id": "h1VzFj2kL9YrQpa4kDzOk",
    "source": "fDWBNPS4VTjkV4oKCZeba",
    "target": "vBJBD3FKF_BTlyZmsMFK-"
  },
  {
    "id": "QEcKre_k_5AW7zyjvQStP",
    "source": "V9QfwAhnKzQ_6ZFnxLcVO",
    "target": "s1oM6Pdk8zqxDGWPDVZpq"
  },
  {
    "id": "oeyCyI5KwUz8ndL8oWQKd",
    "source": "YDMXOjdIOcIH92kDtk4Ey",
    "target": "gp3iUMNORVhAgucTzMGai"
  },
  {
    "id": "lEXvUinf2fxuoaceUKT7J",
    "source": "qKoIIB--Ovbe_uba8NKAO",
    "target": "j8jXc9YE4iEedzd-I59gq"
  },
  {
    "id": "wtq6o5MYlwVH1gkmhTKjm",
    "source": "j8jXc9YE4iEedzd-I59gq",
    "target": "zxt66z0FkxaUnY0UG1hPy"
  },
  {
    "id": "f11b4Y1II7Oa2QzS7DSmz",
    "source": "j8jXc9YE4iEedzd-I59gq",
    "target": "zxt66z0FkxaUnY0UG1hPy"
  },
  {
    "id": "yfTnF-a9utLHtusVzs7-T",
    "source": "qKoIIB--Ovbe_uba8NKAO",
    "target": "j8jXc9YE4iEedzd-I59gq"
  },
  {
    "id": "tLIcHinDCRN701g5iGXsH",
    "source": "1WW8Xa0VhuAPDNEj7B03K",
    "target": "FDiCyisnetyBSxVrCkMbN"
  },
  {
    "id": "4TlDLa74Bs_ttk2NUTM_4",
    "source": "3AwlzPDlqWlbhTP0wJoq3",
    "target": "0j5hsBUpBI3CQ6JT0s9MI"
  },
  {
    "id": "SUX_evJxCpkVJ12VYUfbp",
    "source": "o95EhUGtU205oArqOVQaX",
    "target": "uC3w0YluqoEXMIQQ9Q00u"
  },
  {
    "id": "DbyUzxQ_dyQVi9iCGZMEx",
    "source": "ejIDDiRI2l4zms81H38iB",
    "target": "1cEJOwf4o3XpI_biKR6eY"
  },
  {
    "id": "kQ9VskVIOxXs40No_6hRG",
    "source": "1cEJOwf4o3XpI_biKR6eY",
    "target": "4ujek527tG2zR9tj6ZlfX"
  },
  {
    "id": "PCi-0QjK1MrOPEqR-winp",
    "source": "1cEJOwf4o3XpI_biKR6eY",
    "target": "4ujek527tG2zR9tj6ZlfX"
  },
  {
    "id": "3IqNlVPkyL4vXrWn6fnMn",
    "source": "1cEJOwf4o3XpI_biKR6eY",
    "target": "4ujek527tG2zR9tj6ZlfX"
  }
];
