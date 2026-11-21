// OpenAGI Pocket — dimensional concept, millimeters.
// This is an envelope/clearance study, not a proven printable enclosure.
// Set mode to "shell" for a printable solid, or "layout" for proxy parts.
mode = "layout";
width = 58;
height = 55;
depth = 23;
wall = 1.8;
corner = 14;
$fn = 48;

module rounded_rect(w,h,r){offset(r=r) square([w-2*r,h-2*r],center=true);}
module rounded_box(w,h,d,r){linear_extrude(height=d,center=true) rounded_rect(w,h,r);}

module shell(){
  difference(){
    rounded_box(width,height,depth,corner);
    // Two-piece shell cavity. Open rear; add screw tabs and real tolerances after measurement.
    translate([0,0,wall]) rounded_box(width-2*wall,height-2*wall,depth,corner-wall);
    // OLED active window: 26.86 mm square plus 0.6 mm viewing margin.
    translate([0,0,-depth/2]) linear_extrude(height=wall*2,center=true)
      rounded_rect(27.5,27.5,2);
    // Right-edge rocker clearance.
    translate([width/2,0,0]) cube([wall*3,12,6],center=true);
    // Bottom charging connector access. Connector and strain relief remain to be validated.
    translate([0,-height/2,2]) cube([10,wall*3,5],center=true);
    // Top microphone ports.
    for(x=[-7,7]) translate([x,height/2,0]) rotate([90,0,0]) cylinder(h=wall*3,d=1.1,center=true);
  }
}

module layout(){
  color([.12,.12,.12]) shell();
  // Verified XY module footprint; Z is an allowance, not manufacturer-certified.
  color([.1,.5,.85,.6]) translate([0,0,-6.0]) cube([44.5,37,3],center=true); // Waveshare RGB OLED
  color([.2,.8,.3,.6]) translate([0,0,0]) cube([21,17.8,4],center=true); // XIAO ESP32-S3 board
  color([.9,.5,.1,.6]) translate([0,0,5.2]) cube([30,20,6],center=true); // LiPo proxy ONLY
  color([.8,.2,.5,.6]) translate([-17,19,5]) cube([8,8,3],center=true); // microphone proxy
  color([.8,.2,.5,.6]) translate([17,19,5]) cube([8,8,3],center=true); // second mic proxy
  color([.7,.7,.1,.6]) translate([17,-16,5]) cube([12,12,4],center=true); // speaker/amp proxy
}

if(mode=="shell") shell(); else layout();
