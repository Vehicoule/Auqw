package com.Vehicoule.auqw;

import android.os.Bundle;

import org.qtproject.qt.android.bindings.QtActivity;

public class AuqwActivity extends QtActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        AuqwMediaSessionBridge.attach(this);
    }

    @Override
    protected void onDestroy() {
        AuqwMediaSessionBridge.detach(this);
        super.onDestroy();
    }
}
